import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type {
  AppConfiguration,
  AppRun,
  AppRunStatus,
  CoverageSummary,
  Repository,
  RepositoryDetail,
  RepositoryInput,
  RunConfigurationSnapshot,
  RunDetail,
  RunStatus,
  RunSummary,
  TestResults
} from "@qa-buddy/shared";
import { activeRunStatuses } from "@qa-buddy/shared";

const initialMigrationSql = `
  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    github_url TEXT NOT NULL COLLATE NOCASE UNIQUE,
    default_ref TEXT NOT NULL,
    runner_image TEXT NOT NULL,
    setup_command TEXT,
    timeout_minutes INTEGER NOT NULL,
    environment_allowlist_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    test_command TEXT NOT NULL,
    coverage_format TEXT NOT NULL,
    coverage_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE(repository_id, name COLLATE NOCASE)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    requested_ref TEXT NOT NULL,
    resolved_sha TEXT,
    status TEXT NOT NULL,
    error TEXT,
    configuration_snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX runs_repository_created_idx ON runs(repository_id, created_at DESC);
  CREATE INDEX runs_status_created_idx ON runs(status, created_at ASC);

  CREATE TABLE app_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    test_command TEXT NOT NULL,
    coverage_format TEXT NOT NULL,
    coverage_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    coverage_json TEXT,
    coverage_error TEXT,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX app_runs_run_position_idx ON app_runs(run_id, position ASC);
`;

const migrations = [
  { version: 1, sql: initialMigrationSql },
  {
    version: 2,
    sql: "ALTER TABLE repositories ADD COLUMN auto_detect INTEGER NOT NULL DEFAULT 0;"
  },
  {
    version: 3,
    sql: `
      ALTER TABLE app_runs ADD COLUMN test_results_json TEXT;
      ALTER TABLE app_runs ADD COLUMN test_results_error TEXT;
    `
  },
  {
    version: 4,
    sql: "ALTER TABLE repositories ADD COLUMN build_command TEXT;"
  },
  {
    version: 5,
    sql: "ALTER TABLE repositories ADD COLUMN test_worker_limit INTEGER NOT NULL DEFAULT 2;"
  }
] as const;

interface RepositoryRow {
  id: string;
  name: string;
  github_url: string;
  default_ref: string;
  runner_image: string;
  setup_command: string | null;
  build_command: string | null;
  test_worker_limit: number;
  timeout_minutes: number;
  environment_allowlist_json: string;
  auto_detect: number;
  created_at: string;
  updated_at: string;
}

interface AppRow {
  id: string;
  repository_id: string;
  name: string;
  working_directory: string;
  test_command: string;
  coverage_format: AppConfiguration["coverageFormat"];
  coverage_path: string;
  position: number;
}

interface RunRow {
  id: string;
  repository_id: string;
  requested_ref: string;
  resolved_sha: string | null;
  status: RunStatus;
  error: string | null;
  configuration_snapshot_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface AppRunRow {
  id: string;
  run_id: string;
  name: string;
  working_directory: string;
  test_command: string;
  coverage_format: AppRun["coverageFormat"];
  coverage_path: string;
  position: number;
  status: AppRunStatus;
  exit_code: number | null;
  coverage_json: string | null;
  coverage_error: string | null;
  test_results_json: string | null;
  test_results_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class QaBuddyDatabase {
  readonly connection: BetterSqlite3.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.connection = new BetterSqlite3(databasePath);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedVersions = new Set(
      (
        this.connection.prepare("SELECT version FROM schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version)
    );

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
          .run(migration.version, now());
      })();
    }
  }

  private appsForRepository(repositoryId: string): AppConfiguration[] {
    const rows = this.connection
      .prepare("SELECT * FROM apps WHERE repository_id = ? ORDER BY position ASC")
      .all(repositoryId) as AppRow[];
    return rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      name: row.name,
      workingDirectory: row.working_directory,
      testCommand: row.test_command,
      coverageFormat: row.coverage_format,
      coveragePath: row.coverage_path,
      position: row.position
    }));
  }

  private appRunsForRun(runId: string): AppRun[] {
    const rows = this.connection
      .prepare("SELECT * FROM app_runs WHERE run_id = ? ORDER BY position ASC")
      .all(runId) as AppRunRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      name: row.name,
      workingDirectory: row.working_directory,
      testCommand: row.test_command,
      coverageFormat: row.coverage_format,
      coveragePath: row.coverage_path,
      position: row.position,
      status: row.status,
      exitCode: row.exit_code,
      coverage: row.coverage_json ? (JSON.parse(row.coverage_json) as CoverageSummary) : null,
      coverageError: row.coverage_error,
      testResults: row.test_results_json ? (JSON.parse(row.test_results_json) as TestResults) : null,
      testResultsError: row.test_results_error,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }));
  }

  private mapRun(row: RunRow, detail = false): RunSummary | RunDetail {
    const storedSnapshot = JSON.parse(row.configuration_snapshot_json) as RepositoryInput & {
      selectedApps?: string[] | null;
    };
    const configurationSnapshot: RunConfigurationSnapshot = {
      ...storedSnapshot,
      testWorkerLimit: storedSnapshot.testWorkerLimit ?? 2,
      selectedApps: storedSnapshot.selectedApps ?? null
    };
    const base: RunSummary = {
      id: row.id,
      repositoryId: row.repository_id,
      requestedRef: row.requested_ref,
      resolvedSha: row.resolved_sha,
      status: row.status,
      error: row.error,
      selectedApps: configurationSnapshot.selectedApps,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      appRuns: this.appRunsForRun(row.id)
    };

    if (!detail) return base;
    return {
      ...base,
      configurationSnapshot
    };
  }

  private latestRunForRepository(repositoryId: string): RunSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM runs WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(repositoryId) as RunRow | undefined;
    return row ? (this.mapRun(row) as RunSummary) : null;
  }

  private mapRepository(row: RepositoryRow): Repository {
    return {
      id: row.id,
      name: row.name,
      githubUrl: row.github_url,
      defaultRef: row.default_ref,
      runnerImage: row.runner_image,
      setupCommand: row.setup_command ?? undefined,
      buildCommand: row.build_command ?? undefined,
      testWorkerLimit: row.test_worker_limit,
      timeoutMinutes: row.timeout_minutes,
      environmentAllowlist: JSON.parse(row.environment_allowlist_json) as string[],
      autoDetect: row.auto_detect === 1,
      apps: this.appsForRepository(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestRun: this.latestRunForRepository(row.id)
    };
  }

  private repositoryInput(repository: Repository): RepositoryInput {
    return {
      name: repository.name,
      githubUrl: repository.githubUrl,
      defaultRef: repository.defaultRef,
      runnerImage: repository.runnerImage,
      setupCommand: repository.setupCommand,
      buildCommand: repository.buildCommand,
      testWorkerLimit: repository.testWorkerLimit,
      timeoutMinutes: repository.timeoutMinutes,
      environmentAllowlist: repository.environmentAllowlist,
      autoDetect: repository.autoDetect,
      apps: repository.apps.map(({ id: _id, repositoryId: _repositoryId, position: _position, ...app }) => app)
    };
  }

  listRepositories(): Repository[] {
    const rows = this.connection
      .prepare("SELECT * FROM repositories ORDER BY name COLLATE NOCASE ASC")
      .all() as RepositoryRow[];
    return rows.map((row) => this.mapRepository(row));
  }

  getRepository(id: string): Repository | null {
    const row = this.connection.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as
      | RepositoryRow
      | undefined;
    return row ? this.mapRepository(row) : null;
  }

  getRepositoryDetail(id: string, runLimit = 20): RepositoryDetail | null {
    const repository = this.getRepository(id);
    if (!repository) return null;
    const selectableApps = repository.autoDetect
      ? this.latestDetectedApps(id)
      : this.repositoryInput(repository).apps;
    return { ...repository, selectableApps, runs: this.listRuns(id, runLimit) };
  }

  private latestDetectedApps(repositoryId: string): RepositoryInput["apps"] {
    const rows = this.connection
      .prepare("SELECT configuration_snapshot_json FROM runs WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(repositoryId) as Array<{ configuration_snapshot_json: string }>;
    for (const row of rows) {
      const snapshot = JSON.parse(row.configuration_snapshot_json) as RepositoryInput;
      if (snapshot.apps.length > 0) return snapshot.apps;
    }
    return [];
  }

  createRepository(input: RepositoryInput): Repository {
    const id = randomUUID();
    const timestamp = now();
    this.connection.transaction(() => {
      this.connection
        .prepare(`
          INSERT INTO repositories(
            id, name, github_url, default_ref, runner_image, setup_command,
            build_command, test_worker_limit, timeout_minutes, environment_allowlist_json, auto_detect, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.name,
          input.githubUrl,
          input.defaultRef,
          input.runnerImage,
          input.setupCommand || null,
          input.buildCommand || null,
          input.testWorkerLimit,
          input.timeoutMinutes,
          JSON.stringify(input.environmentAllowlist),
          input.autoDetect ? 1 : 0,
          timestamp,
          timestamp
        );
      this.insertApps(id, input);
    })();
    return this.getRepository(id)!;
  }

  updateRepository(id: string, input: RepositoryInput): Repository | null {
    if (!this.getRepository(id)) return null;
    const timestamp = now();
    this.connection.transaction(() => {
      this.connection
        .prepare(`
          UPDATE repositories SET
            name = ?, github_url = ?, default_ref = ?, runner_image = ?, setup_command = ?,
            build_command = ?, test_worker_limit = ?, timeout_minutes = ?, environment_allowlist_json = ?, auto_detect = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.name,
          input.githubUrl,
          input.defaultRef,
          input.runnerImage,
          input.setupCommand || null,
          input.buildCommand || null,
          input.testWorkerLimit,
          input.timeoutMinutes,
          JSON.stringify(input.environmentAllowlist),
          input.autoDetect ? 1 : 0,
          timestamp,
          id
        );
      this.connection.prepare("DELETE FROM apps WHERE repository_id = ?").run(id);
      this.insertApps(id, input);
    })();
    return this.getRepository(id);
  }

  private insertApps(repositoryId: string, input: RepositoryInput): void {
    const statement = this.connection.prepare(`
      INSERT INTO apps(
        id, repository_id, name, working_directory, test_command,
        coverage_format, coverage_path, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.apps.forEach((app, position) => {
      statement.run(
        randomUUID(),
        repositoryId,
        app.name,
        app.workingDirectory,
        app.testCommand,
        app.coverageFormat,
        app.coveragePath,
        position
      );
    });
  }

  deleteRepository(id: string): { deleted: boolean; active: boolean; runIds: string[] } {
    const active = this.connection
      .prepare(
        `SELECT 1 FROM runs WHERE repository_id = ? AND status IN (${placeholders(activeRunStatuses)}) LIMIT 1`
      )
      .get(id, ...activeRunStatuses);
    if (active) return { deleted: false, active: true, runIds: [] };

    const runIds = (
      this.connection.prepare("SELECT id FROM runs WHERE repository_id = ?").all(id) as Array<{ id: string }>
    ).map((row) => row.id);
    const result = this.connection.prepare("DELETE FROM repositories WHERE id = ?").run(id);
    return { deleted: result.changes > 0, active: false, runIds };
  }

  createRun(repositoryId: string, requestedRef?: string, selectedApps?: string[]): RunDetail {
    const repository = this.getRepository(repositoryId);
    if (!repository) throw new Error("Repository not found");

    const runId = randomUUID();
    const timestamp = now();
    const ref = requestedRef ?? repository.defaultRef;
    const repositorySnapshot = this.repositoryInput(repository);
    const availableByName = new Map(
      repositorySnapshot.apps.map((app) => [app.name.toLocaleLowerCase(), app] as const)
    );
    const uniqueSelection = selectedApps
      ? Array.from(new Set(selectedApps.map((name) => name.toLocaleLowerCase())))
      : null;
    if (!repository.autoDetect && uniqueSelection) {
      const missing = uniqueSelection.filter((name) => !availableByName.has(name));
      if (missing.length > 0) throw new Error(`Unknown app selection: ${missing.join(", ")}`);
    }
    const selectedSet = uniqueSelection ? new Set(uniqueSelection) : null;
    const appsToRun = selectedSet
      ? repositorySnapshot.apps.filter((app) => selectedSet.has(app.name.toLocaleLowerCase()))
      : repositorySnapshot.apps;
    const snapshot: RunConfigurationSnapshot = {
      ...repositorySnapshot,
      selectedApps: uniqueSelection
        ? repository.autoDetect
          ? selectedApps!
          : appsToRun.map((app) => app.name)
        : null
    };

    this.connection.transaction(() => {
      const active = this.connection
        .prepare(
          `SELECT 1 FROM runs WHERE repository_id = ? AND status IN (${placeholders(activeRunStatuses)}) LIMIT 1`
        )
        .get(repositoryId, ...activeRunStatuses);
      if (active) throw new Error("This repository already has a queued or running job");

      this.connection
        .prepare(`
          INSERT INTO runs(
            id, repository_id, requested_ref, status, configuration_snapshot_json, created_at
          ) VALUES (?, ?, ?, 'queued', ?, ?)
        `)
        .run(runId, repositoryId, ref, JSON.stringify(snapshot), timestamp);

      const appStatement = this.connection.prepare(`
        INSERT INTO app_runs(
          id, run_id, name, working_directory, test_command, coverage_format,
          coverage_path, position, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `);
      appsToRun.forEach((app, position) => {
        appStatement.run(
          randomUUID(),
          runId,
          app.name,
          app.workingDirectory,
          app.testCommand,
          app.coverageFormat,
          app.coveragePath,
          position
        );
      });
    }).immediate();

    return this.getRun(runId)!;
  }

  listRuns(repositoryId: string, limit = 20): RunSummary[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(repositoryId, limit) as RunRow[];
    return rows.map((row) => this.mapRun(row) as RunSummary);
  }

  getRun(id: string): RunDetail | null {
    const row = this.connection.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? (this.mapRun(row, true) as RunDetail) : null;
  }

  claimNextRun(): RunDetail | null {
    const id = this.connection.transaction(() => {
      const row = this.connection
        .prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get() as { id: string } | undefined;
      if (!row) return null;
      const result = this.connection
        .prepare("UPDATE runs SET status = 'cloning', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), row.id);
      return result.changes === 1 ? row.id : null;
    }).immediate();
    return id ? this.getRun(id) : null;
  }

  updateRun(
    id: string,
    values: {
      status?: RunStatus;
      resolvedSha?: string | null;
      error?: string | null;
      finished?: boolean;
    }
  ): void {
    const current = this.getRun(id);
    if (!current) return;
    this.connection
      .prepare(`
        UPDATE runs SET status = ?, resolved_sha = ?, error = ?, finished_at = ? WHERE id = ?
      `)
      .run(
        values.status ?? current.status,
        values.resolvedSha === undefined ? current.resolvedSha : values.resolvedSha,
        values.error === undefined ? current.error : values.error,
        values.finished ? now() : current.finishedAt,
        id
      );
  }

  startAppRun(id: string): void {
    this.connection
      .prepare("UPDATE app_runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(now(), id);
  }

  setDetectedApps(runId: string, apps: RepositoryInput["apps"]): RunDetail {
    const run = this.getRun(runId);
    if (!run) throw new Error("Run not found");
    const selectedNames = run.configurationSnapshot.selectedApps;
    const selectedSet = selectedNames
      ? new Set(selectedNames.map((name) => name.toLocaleLowerCase()))
      : null;
    const appsToRun = selectedSet
      ? apps.filter((app) => selectedSet.has(app.name.toLocaleLowerCase()))
      : apps;
    if (selectedSet) {
      const detectedNames = new Set(apps.map((app) => app.name.toLocaleLowerCase()));
      const missing = selectedNames!.filter((name) => !detectedNames.has(name.toLocaleLowerCase()));
      if (missing.length > 0) {
        throw new Error(`Selected app${missing.length === 1 ? " was" : "s were"} not detected on this ref: ${missing.join(", ")}`);
      }
    }
    const snapshot: RunConfigurationSnapshot = {
      ...run.configurationSnapshot,
      apps,
      selectedApps: selectedSet ? appsToRun.map((app) => app.name) : null
    };

    this.connection.transaction(() => {
      this.connection
        .prepare("UPDATE runs SET configuration_snapshot_json = ? WHERE id = ?")
        .run(JSON.stringify(snapshot), runId);
      this.connection.prepare("DELETE FROM app_runs WHERE run_id = ?").run(runId);
      const statement = this.connection.prepare(`
        INSERT INTO app_runs(
          id, run_id, name, working_directory, test_command, coverage_format,
          coverage_path, position, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `);
      appsToRun.forEach((app, position) => {
        statement.run(
          randomUUID(),
          runId,
          app.name,
          app.workingDirectory,
          app.testCommand,
          app.coverageFormat,
          app.coveragePath,
          position
        );
      });
    })();

    return this.getRun(runId)!;
  }

  finishAppRun(
    id: string,
    values: {
      status: Extract<AppRunStatus, "passed" | "failed" | "skipped">;
      exitCode?: number | null;
      coverage?: CoverageSummary | null;
      coverageError?: string | null;
      coverageFormat?: AppRun["coverageFormat"];
      coveragePath?: string;
      testResults?: TestResults | null;
      testResultsError?: string | null;
    }
  ): void {
    this.connection
      .prepare(`
        UPDATE app_runs SET
          status = ?, exit_code = ?, coverage_json = ?, coverage_error = ?,
          test_results_json = ?, test_results_error = ?,
          coverage_format = COALESCE(?, coverage_format),
          coverage_path = COALESCE(?, coverage_path), finished_at = ?
        WHERE id = ?
      `)
      .run(
        values.status,
        values.exitCode ?? null,
        values.coverage ? JSON.stringify(values.coverage) : null,
        values.coverageError ?? null,
        values.testResults ? JSON.stringify(values.testResults) : null,
        values.testResultsError ?? null,
        values.coverageFormat ?? null,
        values.coveragePath ?? null,
        now(),
        id
      );
  }

  skipPendingApps(runId: string, reason: string): void {
    this.connection
      .prepare(`
        UPDATE app_runs
        SET status = 'skipped', coverage_error = ?, finished_at = ?
        WHERE run_id = ? AND status IN ('pending', 'running')
      `)
      .run(reason, now(), runId);
  }

  markActiveRunsInterrupted(): string[] {
    const active = ["cloning", "setup", "building", "testing"] as const;
    const rows = this.connection
      .prepare(`SELECT id FROM runs WHERE status IN (${placeholders(active)})`)
      .all(...active) as Array<{ id: string }>;
    const timestamp = now();
    this.connection.transaction(() => {
      for (const { id } of rows) {
        this.connection
          .prepare(
            "UPDATE runs SET status = 'interrupted', error = ?, finished_at = ? WHERE id = ?"
          )
          .run("Worker restarted while this run was active", timestamp, id);
        this.connection
          .prepare(`
            UPDATE app_runs SET status = 'skipped', coverage_error = ?, finished_at = ?
            WHERE run_id = ? AND status IN ('pending', 'running')
          `)
          .run("Run interrupted by worker restart", timestamp, id);
      }
    })();
    return rows.map((row) => row.id);
  }

  pruneRuns(repositoryId: string, keep: number): string[] {
    const rows = this.connection
      .prepare("SELECT id FROM runs WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?")
      .all(repositoryId, keep) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    this.connection
      .prepare(`DELETE FROM runs WHERE id IN (${placeholders(ids)})`)
      .run(...ids);
    return ids;
  }
}
