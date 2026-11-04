import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type {
  AppConfiguration,
  AppGroup,
  AppGroupInput,
  AppRun,
  AppRunStatus,
  CoverageFileEntry,
  CoverageFilePage,
  CoverageFileQuery,
  CoverageFileRow,
  CoverageHistoryEntry,
  CoverageMetricName,
  CoverageSnapshot,
  CoverageSummary,
  Repository,
  RepositoryDetail,
  RepositoryInput,
  RunConfigurationSnapshot,
  RunDetail,
  RunStatus,
  RunSummary,
  Slice,
  SliceBuild,
  SliceBuildStatus,
  SliceConfig,
  SliceDetail,
  SliceBackendSummary,
  SliceEndpoint,
  SliceUnmatchedCall,
  CoverageExportRow,
  TestResults
} from "@qa-buddy/shared";
import {
  activeRunStatuses,
  activeSliceBuildStatuses,
  coverageMetricNames,
  normalizeSliceConfig,
  terminalRunStatuses
} from "@qa-buddy/shared";

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

const coverageMetricColumns = coverageMetricNames
  .flatMap((metric) => [`${metric}_covered`, `${metric}_total`])
  .join(", ");

const coverageMetricValues = coverageMetricNames
  .flatMap((metric) => [
    `json_extract(a.coverage_json, '$.${metric}.covered')`,
    `json_extract(a.coverage_json, '$.${metric}.total')`
  ])
  .join(", ");

/**
 * Copies app results from completed runs into coverage_history. Shared by the
 * migration backfill and the per-run write so both record the same shape.
 */
const coverageHistoryInsertSql = `
  INSERT OR IGNORE INTO coverage_history(
    run_id, repository_id, app_name, requested_ref, resolved_sha,
    use_local_working_tree, dirty, recorded_at, ${coverageMetricColumns},
    tests_total, tests_passed, tests_failed
  )
  SELECT
    r.id, r.repository_id, a.name, r.requested_ref, r.resolved_sha,
    r.use_local_working_tree, r.dirty, COALESCE(r.finished_at, r.created_at), ${coverageMetricValues},
    json_extract(a.test_results_json, '$.total'),
    json_extract(a.test_results_json, '$.passed'),
    json_extract(a.test_results_json, '$.failed')
  FROM app_runs a
  JOIN runs r ON r.id = a.run_id
  WHERE r.status IN ('passed', 'failed')
    AND a.status IN ('passed', 'failed')
    AND (a.coverage_json IS NOT NULL OR a.test_results_json IS NOT NULL)
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
  },
  {
    version: 6,
    sql: `
      ALTER TABLE repositories ADD COLUMN local_path TEXT;
      ALTER TABLE runs ADD COLUMN use_local_working_tree INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 7,
    // run_id is intentionally not a foreign key: snapshots must survive the run
    // history pruning that deletes the run they were captured from.
    sql: `
      CREATE TABLE coverage_snapshots (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        app_name TEXT NOT NULL,
        run_id TEXT,
        resolved_sha TEXT,
        coverage_format TEXT NOT NULL,
        coverage_path TEXT,
        summary_json TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE(repository_id, app_name COLLATE NOCASE)
      );

      CREATE TABLE coverage_files (
        snapshot_id TEXT NOT NULL REFERENCES coverage_snapshots(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        lines_covered INTEGER,
        lines_total INTEGER,
        statements_covered INTEGER,
        statements_total INTEGER,
        functions_covered INTEGER,
        functions_total INTEGER,
        branches_covered INTEGER,
        branches_total INTEGER,
        PRIMARY KEY (snapshot_id, file_path)
      );

      CREATE INDEX coverage_files_snapshot_idx ON coverage_files(snapshot_id);
    `
  },
  {
    version: 8,
    sql: "ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;"
  },
  {
    version: 9,
    sql: "ALTER TABLE repositories ADD COLUMN additional_workspaces_json TEXT NOT NULL DEFAULT '[]';"
  },
  {
    version: 10,
    sql: `
      CREATE TABLE app_groups (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        app_names_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repository_id, name COLLATE NOCASE)
      );

      CREATE INDEX app_groups_repository_idx ON app_groups(repository_id, name COLLATE NOCASE);
    `
  },
  {
    // 11 and 12 are reserved for the Cypress-add-on branch, which already
    // applies them to shared data volumes.
    version: 13,
    // Like coverage_snapshots, run_id is not a foreign key so history survives
    // run pruning. Existing completed runs are backfilled.
    sql: `
      CREATE TABLE coverage_history (
        run_id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        app_name TEXT NOT NULL,
        requested_ref TEXT NOT NULL,
        resolved_sha TEXT,
        use_local_working_tree INTEGER NOT NULL,
        dirty INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        lines_covered INTEGER,
        lines_total INTEGER,
        statements_covered INTEGER,
        statements_total INTEGER,
        functions_covered INTEGER,
        functions_total INTEGER,
        branches_covered INTEGER,
        branches_total INTEGER,
        tests_total INTEGER,
        tests_passed INTEGER,
        tests_failed INTEGER,
        PRIMARY KEY (run_id, app_name)
      );

      CREATE INDEX coverage_history_repository_idx ON coverage_history(repository_id, recorded_at ASC);

      ${coverageHistoryInsertSql};
    `
  },
  {
    version: 14,
    // Groups start in their previous alphabetical order.
    sql: `
      ALTER TABLE app_groups ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      UPDATE app_groups SET position = (
        SELECT COUNT(*) FROM app_groups AS earlier
        WHERE earlier.repository_id = app_groups.repository_id
          AND (earlier.name COLLATE NOCASE < app_groups.name COLLATE NOCASE
            OR (earlier.name COLLATE NOCASE = app_groups.name COLLATE NOCASE AND earlier.id < app_groups.id))
      );
    `
  },
  {
    version: 15,
    sql: "ALTER TABLE repositories ADD COLUMN coverage_goal REAL;"
  },
  {
    version: 16,
    sql: "ALTER TABLE repositories ADD COLUMN excluded_workspaces_json TEXT NOT NULL DEFAULT '[]';"
  },
  {
    version: 17,
    // Slices: the backend files each frontend depends on. slices.build_id and
    // slice_history.run_id are not foreign keys so slices and their trend
    // survive build and run pruning, like coverage snapshots and history.
    sql: `
      ALTER TABLE repositories ADD COLUMN slice_config_json TEXT;

      CREATE TABLE slice_builds (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        requested_ref TEXT NOT NULL,
        use_local_working_tree INTEGER NOT NULL DEFAULT 0,
        resolved_sha TEXT,
        dirty INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        slice_count INTEGER,
        skipped_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX slice_builds_repository_idx ON slice_builds(repository_id, created_at DESC);

      CREATE TABLE slices (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        build_id TEXT NOT NULL,
        name TEXT NOT NULL,
        frontend_directory TEXT NOT NULL,
        backend_directory TEXT NOT NULL,
        resolved_sha TEXT,
        built_at TEXT NOT NULL,
        endpoint_count INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        endpoints_json TEXT NOT NULL,
        UNIQUE(repository_id, name COLLATE NOCASE)
      );

      CREATE TABLE slice_files (
        slice_id TEXT NOT NULL REFERENCES slices(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        PRIMARY KEY (slice_id, file_path)
      );
      CREATE INDEX slice_files_path_idx ON slice_files(file_path);
      CREATE INDEX coverage_files_path_idx ON coverage_files(file_path);

      CREATE TABLE slice_history (
        run_id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        slice_name TEXT NOT NULL,
        requested_ref TEXT NOT NULL,
        resolved_sha TEXT,
        use_local_working_tree INTEGER NOT NULL,
        dirty INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        lines_covered INTEGER,
        lines_total INTEGER,
        statements_covered INTEGER,
        statements_total INTEGER,
        functions_covered INTEGER,
        functions_total INTEGER,
        branches_covered INTEGER,
        branches_total INTEGER,
        measured_files INTEGER NOT NULL,
        PRIMARY KEY (run_id, slice_name)
      );
      CREATE INDEX slice_history_repository_idx ON slice_history(repository_id, recorded_at ASC);
    `
  },
  {
    version: 18,
    // Slices may span several backends: each slice file records the backend it
    // belongs to, and slices keep a per-backend summary and unmatched requests.
    sql: `
      ALTER TABLE slice_files ADD COLUMN backend_directory TEXT NOT NULL DEFAULT '';
      UPDATE slice_files SET backend_directory = (
        SELECT backend_directory FROM slices WHERE slices.id = slice_files.slice_id
      );
      ALTER TABLE slices ADD COLUMN backends_json TEXT NOT NULL DEFAULT '[]';
      UPDATE slices SET backends_json = json_array(json_object('directory', backend_directory, 'endpointCount', endpoint_count));
      ALTER TABLE slices ADD COLUMN unmatched_calls_json TEXT NOT NULL DEFAULT '[]';
    `
  }
] as const;

interface RepositoryRow {
  id: string;
  name: string;
  github_url: string;
  default_ref: string;
  local_path: string | null;
  additional_workspaces_json: string;
  excluded_workspaces_json: string;
  runner_image: string;
  setup_command: string | null;
  build_command: string | null;
  test_worker_limit: number;
  timeout_minutes: number;
  environment_allowlist_json: string;
  auto_detect: number;
  coverage_goal: number | null;
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
  use_local_working_tree: number;
  dirty: number;
  cancel_requested: number;
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

interface AppGroupRow {
  id: string;
  repository_id: string;
  name: string;
  app_names_json: string;
  created_at: string;
  updated_at: string;
}

interface CoverageSnapshotRow {
  id: string;
  repository_id: string;
  app_name: string;
  run_id: string | null;
  resolved_sha: string | null;
  coverage_format: CoverageSnapshot["coverageFormat"];
  coverage_path: string | null;
  summary_json: string;
  file_count: number;
  captured_at: string;
}

type CoverageHistoryRow = {
  run_id: string;
  app_name: string;
  requested_ref: string;
  resolved_sha: string | null;
  use_local_working_tree: number;
  dirty: number;
  recorded_at: string;
  tests_total: number | null;
  tests_passed: number | null;
  tests_failed: number | null;
} & Record<`${CoverageMetricName}_${"covered" | "total"}`, number | null>;

interface CoverageFileRowRecord {
  app_name: string;
  snapshot_id: string;
  file_path: string;
  lines_covered: number | null;
  lines_total: number | null;
  statements_covered: number | null;
  statements_total: number | null;
  functions_covered: number | null;
  functions_total: number | null;
  branches_covered: number | null;
  branches_total: number | null;
}

interface SliceBuildRow {
  id: string;
  repository_id: string;
  status: SliceBuildStatus;
  requested_ref: string;
  use_local_working_tree: number;
  resolved_sha: string | null;
  dirty: number;
  error: string | null;
  slice_count: number | null;
  skipped_json: string;
  config_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

type SliceRow = {
  id: string;
  repository_id: string;
  build_id: string;
  name: string;
  frontend_directory: string;
  backend_directory: string;
  resolved_sha: string | null;
  built_at: string;
  endpoint_count: number;
  file_count: number;
  endpoints_json: string;
  backends_json: string;
  unmatched_calls_json: string;
  measured_files: number;
  /** `captured_at|resolved_sha` of the newest snapshot a slice file came from. */
  coverage_source: string | null;
} & Record<`${CoverageMetricName}_${"covered" | "total"}`, number | null>;

type SliceHistoryRow = {
  run_id: string;
  slice_name: string;
  requested_ref: string;
  resolved_sha: string | null;
  use_local_working_tree: number;
  dirty: number;
  recorded_at: string;
} & Record<`${CoverageMetricName}_${"covered" | "total"}`, number | null>;

/** A slice as traced by the worker, ready to store. */
export interface SliceInput {
  name: string;
  frontendDirectory: string;
  endpoints: SliceEndpoint[];
  backends: Array<{ directory: string; endpointCount: number; files: string[] }>;
  unmatchedCalls?: SliceUnmatchedCall[];
}

type MetricSums = Record<`${CoverageMetricName}_${"covered" | "total"}`, number | null>;

function now(): string {
  return new Date().toISOString();
}

function percentMetric(covered: number | null, total: number | null) {
  return covered === null || total === null
    ? null
    : { covered, total, percent: total === 0 ? null : Math.round((covered / total) * 1_000) / 10 };
}

/**
 * Sums per-file coverage into one summary. A metric is null when no file
 * reported it, so slices without measured files never read as 0%.
 */
export function sumCoverage(files: Array<Pick<CoverageFileEntry, CoverageMetricName>>): CoverageSummary {
  const summary = {} as CoverageSummary;
  for (const metric of coverageMetricNames) {
    let covered = 0;
    let total = 0;
    let reported = false;
    for (const file of files) {
      const value = file[metric];
      if (!value) continue;
      reported = true;
      covered += value.covered;
      total += value.total;
    }
    summary[metric] = reported ? percentMetric(covered, total) : null;
  }
  return summary;
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
      excludedWorkspaces: storedSnapshot.excludedWorkspaces ?? [],
      selectedApps: storedSnapshot.selectedApps ?? null
    };
    const base: RunSummary = {
      id: row.id,
      repositoryId: row.repository_id,
      requestedRef: row.requested_ref,
      resolvedSha: row.resolved_sha,
      useLocalWorkingTree: row.use_local_working_tree === 1,
      dirty: row.dirty === 1,
      cancelRequested: row.cancel_requested === 1,
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

  /**
   * Interrupted and timed-out runs stop partway through, so only runs that
   * reached a pass/fail verdict count as complete results.
   */
  private latestCompletedRunForRepository(repositoryId: string): RunSummary | null {
    const row = this.connection
      .prepare(`
        SELECT * FROM runs
        WHERE repository_id = ? AND status IN ('passed', 'failed')
        ORDER BY finished_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(repositoryId) as RunRow | undefined;
    return row ? (this.mapRun(row) as RunSummary) : null;
  }

  private mapRepository(row: RepositoryRow): Repository {
    return {
      id: row.id,
      name: row.name,
      githubUrl: row.github_url,
      defaultRef: row.default_ref,
      localPath: row.local_path ?? undefined,
      additionalWorkspaces: JSON.parse(row.additional_workspaces_json) as string[],
      excludedWorkspaces: JSON.parse(row.excluded_workspaces_json) as string[],
      runnerImage: row.runner_image,
      setupCommand: row.setup_command ?? undefined,
      buildCommand: row.build_command ?? undefined,
      testWorkerLimit: row.test_worker_limit,
      timeoutMinutes: row.timeout_minutes,
      environmentAllowlist: JSON.parse(row.environment_allowlist_json) as string[],
      autoDetect: row.auto_detect === 1,
      coverageGoal: row.coverage_goal,
      apps: this.appsForRepository(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestRun: this.latestRunForRepository(row.id),
      latestCompletedRun: this.latestCompletedRunForRepository(row.id)
    };
  }

  private repositoryInput(repository: Repository): RepositoryInput {
    return {
      name: repository.name,
      githubUrl: repository.githubUrl,
      defaultRef: repository.defaultRef,
      localPath: repository.localPath,
      additionalWorkspaces: repository.additionalWorkspaces,
      excludedWorkspaces: repository.excludedWorkspaces,
      runnerImage: repository.runnerImage,
      setupCommand: repository.setupCommand,
      buildCommand: repository.buildCommand,
      testWorkerLimit: repository.testWorkerLimit,
      timeoutMinutes: repository.timeoutMinutes,
      environmentAllowlist: repository.environmentAllowlist,
      autoDetect: repository.autoDetect,
      coverageGoal: repository.coverageGoal,
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
    // Apply current exclusions to the last detection so a newly excluded app
    // stops being selectable before the next run confirms it.
    const excluded = new Set(repository.excludedWorkspaces);
    const selectableApps = repository.autoDetect
      ? this.latestDetectedApps(id).filter((app) => !excluded.has(app.workingDirectory))
      : this.repositoryInput(repository).apps;
    return {
      ...repository,
      selectableApps,
      appGroups: this.listAppGroups(id),
      runs: this.listRuns(id, runLimit)
    };
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
            id, name, github_url, default_ref, local_path, additional_workspaces_json, excluded_workspaces_json,
            runner_image, setup_command, build_command, test_worker_limit, timeout_minutes, environment_allowlist_json,
            auto_detect, coverage_goal, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.name,
          input.githubUrl,
          input.defaultRef,
          input.localPath || null,
          JSON.stringify(input.additionalWorkspaces ?? []),
          JSON.stringify(input.excludedWorkspaces ?? []),
          input.runnerImage,
          input.setupCommand || null,
          input.buildCommand || null,
          input.testWorkerLimit,
          input.timeoutMinutes,
          JSON.stringify(input.environmentAllowlist),
          input.autoDetect ? 1 : 0,
          input.coverageGoal ?? null,
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
            name = ?, github_url = ?, default_ref = ?, local_path = ?, additional_workspaces_json = ?,
            excluded_workspaces_json = ?, runner_image = ?, setup_command = ?,
            build_command = ?, test_worker_limit = ?, timeout_minutes = ?, environment_allowlist_json = ?, auto_detect = ?,
            coverage_goal = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.name,
          input.githubUrl,
          input.defaultRef,
          input.localPath || null,
          JSON.stringify(input.additionalWorkspaces ?? []),
          JSON.stringify(input.excludedWorkspaces ?? []),
          input.runnerImage,
          input.setupCommand || null,
          input.buildCommand || null,
          input.testWorkerLimit,
          input.timeoutMinutes,
          JSON.stringify(input.environmentAllowlist),
          input.autoDetect ? 1 : 0,
          input.coverageGoal ?? null,
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

  createRun(
    repositoryId: string,
    requestedRef?: string,
    selectedApps?: string[],
    useLocalWorkingTree = false
  ): RunDetail {
    const repository = this.getRepository(repositoryId);
    if (!repository) throw new Error("Repository not found");
    if (useLocalWorkingTree && !repository.localPath) {
      throw new Error("This repository has no local checkout path configured");
    }

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
            id, repository_id, requested_ref, use_local_working_tree, status, configuration_snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
        `)
        .run(
          runId,
          repositoryId,
          ref,
          useLocalWorkingTree ? 1 : 0,
          JSON.stringify(snapshot),
          timestamp
        );

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



  // ----- Saved application groups ----------------------------------------------------

  private mapAppGroup(row: AppGroupRow): AppGroup {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      name: row.name,
      appNames: JSON.parse(row.app_names_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listAppGroups(repositoryId: string): AppGroup[] {
    const rows = this.connection
      .prepare("SELECT * FROM app_groups WHERE repository_id = ? ORDER BY position ASC, name COLLATE NOCASE ASC")
      .all(repositoryId) as AppGroupRow[];
    return rows.map((row) => this.mapAppGroup(row));
  }

  getAppGroup(id: string): AppGroup | null {
    const row = this.connection.prepare("SELECT * FROM app_groups WHERE id = ?").get(id) as
      | AppGroupRow
      | undefined;
    return row ? this.mapAppGroup(row) : null;
  }

  createAppGroup(repositoryId: string, input: AppGroupInput): AppGroup {
    const id = randomUUID();
    const timestamp = now();
    try {
      this.connection
        .prepare(`
          INSERT INTO app_groups(id, repository_id, name, app_names_json, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM app_groups WHERE repository_id = ?), ?, ?)
        `)
        .run(id, repositoryId, input.name, JSON.stringify(input.appNames), repositoryId, timestamp, timestamp);
    } catch (error) {
      throw this.appGroupNameConflict(error, input.name);
    }
    return this.getAppGroup(id)!;
  }

  /** Renames a group, replaces its apps, or both. */
  updateAppGroup(id: string, input: Partial<AppGroupInput>): AppGroup | null {
    const current = this.getAppGroup(id);
    if (!current) return null;
    const name = input.name ?? current.name;
    const appNames = input.appNames ?? current.appNames;
    try {
      this.connection
        .prepare("UPDATE app_groups SET name = ?, app_names_json = ?, updated_at = ? WHERE id = ?")
        .run(name, JSON.stringify(appNames), now(), id);
    } catch (error) {
      throw this.appGroupNameConflict(error, name);
    }
    return this.getAppGroup(id);
  }

  /**
   * Applies a new display order. The ids must be exactly the repository's
   * groups, so a stale page cannot silently drop or duplicate one.
   */
  reorderAppGroups(repositoryId: string, groupIds: string[]): AppGroup[] | null {
    const current = this.listAppGroups(repositoryId).map((group) => group.id);
    if (current.length !== groupIds.length || !groupIds.every((id) => current.includes(id))) return null;
    const statement = this.connection.prepare("UPDATE app_groups SET position = ? WHERE id = ?");
    this.connection.transaction(() => {
      groupIds.forEach((id, position) => statement.run(position, id));
    })();
    return this.listAppGroups(repositoryId);
  }

  deleteAppGroup(id: string): boolean {
    return this.connection.prepare("DELETE FROM app_groups WHERE id = ?").run(id).changes > 0;
  }

  private appGroupNameConflict(error: unknown, name: string): Error {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") && message.includes("app_groups")) {
      return new Error(`A group named "${name}" already exists for this repository`);
    }
    return error instanceof Error ? error : new Error("Unable to save the group");
  }

  // ----- Per-file coverage snapshots -------------------------------------------------

  private mapCoverageFileRow(row: CoverageFileRowRecord): CoverageFileRow {
    const build = (covered: number | null, total: number | null) =>
      covered === null || total === null
        ? null
        : { covered, total, percent: total === 0 ? null : Math.round((covered / total) * 1_000) / 10 };
    return {
      appName: row.app_name,
      path: row.file_path,
      lines: build(row.lines_covered, row.lines_total),
      statements: build(row.statements_covered, row.statements_total),
      functions: build(row.functions_covered, row.functions_total),
      branches: build(row.branches_covered, row.branches_total)
    };
  }

  /**
   * Replaces the snapshot for one app. Callers are expected to skip runs whose
   * source was a local working tree, so the snapshot always reflects a commit
   * that exists on the remote.
   */
  replaceCoverageSnapshot(
    repositoryId: string,
    appName: string,
    values: {
      runId: string | null;
      resolvedSha: string | null;
      coverageFormat: CoverageSnapshot["coverageFormat"];
      coveragePath: string | null;
      summary: CoverageSummary;
      files: CoverageFileEntry[];
    }
  ): void {
    const snapshotId = randomUUID();
    const timestamp = now();
    this.connection.transaction(() => {
      this.connection
        .prepare("DELETE FROM coverage_snapshots WHERE repository_id = ? AND app_name = ? COLLATE NOCASE")
        .run(repositoryId, appName);
      this.connection
        .prepare(`
          INSERT INTO coverage_snapshots(
            id, repository_id, app_name, run_id, resolved_sha, coverage_format,
            coverage_path, summary_json, file_count, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          snapshotId,
          repositoryId,
          appName,
          values.runId,
          values.resolvedSha,
          values.coverageFormat,
          values.coveragePath,
          JSON.stringify(values.summary),
          values.files.length,
          timestamp
        );

      const statement = this.connection.prepare(`
        INSERT INTO coverage_files(
          snapshot_id, file_path,
          lines_covered, lines_total, statements_covered, statements_total,
          functions_covered, functions_total, branches_covered, branches_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of values.files) {
        statement.run(
          snapshotId,
          file.path,
          file.lines?.covered ?? null,
          file.lines?.total ?? null,
          file.statements?.covered ?? null,
          file.statements?.total ?? null,
          file.functions?.covered ?? null,
          file.functions?.total ?? null,
          file.branches?.covered ?? null,
          file.branches?.total ?? null
        );
      }
    })();
  }

  listCoverageSnapshots(repositoryId: string): CoverageSnapshot[] {
    const rows = this.connection
      .prepare("SELECT * FROM coverage_snapshots WHERE repository_id = ? ORDER BY app_name COLLATE NOCASE ASC")
      .all(repositoryId) as CoverageSnapshotRow[];
    return rows.map((row) => ({
      repositoryId: row.repository_id,
      appName: row.app_name,
      runId: row.run_id,
      resolvedSha: row.resolved_sha,
      coverageFormat: row.coverage_format,
      coveragePath: row.coverage_path,
      fileCount: row.file_count,
      capturedAt: row.captured_at,
      summary: JSON.parse(row.summary_json) as CoverageSummary
    }));
  }

  listCoverageHistory(repositoryId: string): CoverageHistoryEntry[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM coverage_history
        WHERE repository_id = ?
        ORDER BY recorded_at ASC, run_id ASC, app_name COLLATE NOCASE ASC
      `)
      .all(repositoryId) as CoverageHistoryRow[];
    return rows.map((row) => {
      const metric = (name: CoverageMetricName) => {
        const covered = row[`${name}_covered`];
        const total = row[`${name}_total`];
        return covered === null || total === null
          ? null
          : { covered, total, percent: total === 0 ? null : Math.round((covered / total) * 1_000) / 10 };
      };
      return {
        runId: row.run_id,
        appName: row.app_name,
        requestedRef: row.requested_ref,
        resolvedSha: row.resolved_sha,
        useLocalWorkingTree: row.use_local_working_tree === 1,
        dirty: row.dirty === 1,
        recordedAt: row.recorded_at,
        coverage: {
          lines: metric("lines"),
          statements: metric("statements"),
          functions: metric("functions"),
          branches: metric("branches")
        },
        tests:
          row.tests_total === null
            ? null
            : { total: row.tests_total, passed: row.tests_passed ?? 0, failed: row.tests_failed ?? 0 }
      };
    });
  }

  queryCoverageFiles(repositoryId: string, query: CoverageFileQuery = {}): CoverageFilePage {
    const metric: CoverageMetricName = coverageMetricNames.includes(query.metric as CoverageMetricName)
      ? (query.metric as CoverageMetricName)
      : "lines";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);
    const offset = Math.max(query.offset ?? 0, 0);

    const conditions = ["s.repository_id = ?"];
    const parameters: unknown[] = [repositoryId];
    if (query.appName) {
      conditions.push("s.app_name = ? COLLATE NOCASE");
      parameters.push(query.appName);
    }
    if (query.sliceName) {
      conditions.push(`f.file_path IN (
        SELECT sf.file_path FROM slice_files sf JOIN slices sl ON sl.id = sf.slice_id
        WHERE sl.repository_id = s.repository_id AND sl.name = ? COLLATE NOCASE
      )`);
      parameters.push(query.sliceName);
    }
    if (query.search) {
      conditions.push("f.file_path LIKE ? ESCAPE '\\'");
      parameters.push(`%${query.search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }
    // Files with a zero denominator have no measurable coverage; they are never
    // "gaps" and would otherwise sort as 0%.
    const ratio = `CAST(f.${metric}_covered AS REAL) / NULLIF(f.${metric}_total, 0)`;
    if (query.maxPercent !== undefined) {
      conditions.push(`${ratio} IS NOT NULL AND ${ratio} <= ?`);
      parameters.push(query.maxPercent / 100);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const total = (
      this.connection
        .prepare(`
          SELECT COUNT(*) AS count FROM coverage_files f
          JOIN coverage_snapshots s ON s.id = f.snapshot_id
          ${where}
        `)
        .get(...parameters) as { count: number }
    ).count;

    const rows = this.connection
      .prepare(`
        SELECT s.app_name, f.* FROM coverage_files f
        JOIN coverage_snapshots s ON s.id = f.snapshot_id
        ${where}
        ORDER BY (${ratio}) IS NULL ASC, ${ratio} ASC, f.file_path ASC
        LIMIT ? OFFSET ?
      `)
      .all(...parameters, limit, offset) as CoverageFileRowRecord[];

    return { files: rows.map((row) => this.mapCoverageFileRow(row)), total, limit, offset };
  }

  updateRun(
    id: string,
    values: {
      status?: RunStatus;
      resolvedSha?: string | null;
      error?: string | null;
      dirty?: boolean;
      finished?: boolean;
    }
  ): void {
    const current = this.getRun(id);
    if (!current) return;
    this.connection
      .prepare(`
        UPDATE runs SET status = ?, resolved_sha = ?, error = ?, dirty = ?, finished_at = ? WHERE id = ?
      `)
      .run(
        values.status ?? current.status,
        values.resolvedSha === undefined ? current.resolvedSha : values.resolvedSha,
        values.error === undefined ? current.error : values.error,
        (values.dirty === undefined ? current.dirty : values.dirty) ? 1 : 0,
        values.finished ? now() : current.finishedAt,
        id
      );
    if (values.finished && (values.status === "passed" || values.status === "failed")) {
      this.connection.prepare(`${coverageHistoryInsertSql} AND r.id = ?`).run(id);
    }
  }

  startAppRun(id: string): void {
    this.connection
      .prepare("UPDATE app_runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(now(), id);
  }

  /**
   * Durations in milliseconds of each app's most recent passing runs in this
   * repository, newest first, keyed by app name.
   */
  recentPassingAppDurations(repositoryId: string, perApp: number): Map<string, number[]> {
    const rows = this.connection
      .prepare(`
        SELECT name, started_at, finished_at FROM (
          SELECT a.name, a.started_at, a.finished_at,
            ROW_NUMBER() OVER (PARTITION BY a.name ORDER BY a.finished_at DESC) AS recency
          FROM app_runs a
          JOIN runs r ON r.id = a.run_id
          WHERE r.repository_id = ? AND a.status = 'passed'
            AND a.started_at IS NOT NULL AND a.finished_at IS NOT NULL
        )
        WHERE recency <= ?
        ORDER BY name, recency
      `)
      .all(repositoryId, perApp) as Array<{ name: string; started_at: string; finished_at: string }>;
    const durations = new Map<string, number[]>();
    for (const row of rows) {
      const duration = Date.parse(row.finished_at) - Date.parse(row.started_at);
      if (!Number.isFinite(duration) || duration < 0) continue;
      durations.set(row.name, [...(durations.get(row.name) ?? []), duration]);
    }
    return durations;
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


  /**
   * Requests that a run stop. A run the worker has not claimed yet is ended
   * immediately; an in-flight run gets a flag the worker polls between steps.
   */
  requestRunCancellation(
    runId: string
  ): "not_found" | "already_finished" | "stopped" | "requested" {
    return this.connection.transaction(() => {
      const row = this.connection.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
        | { status: RunStatus }
        | undefined;
      if (!row) return "not_found" as const;
      if (terminalRunStatuses.includes(row.status)) return "already_finished" as const;

      if (row.status === "queued") {
        const result = this.connection
          .prepare(`
            UPDATE runs
            SET status = 'interrupted', cancel_requested = 1, error = ?, finished_at = ?
            WHERE id = ? AND status = 'queued'
          `)
          .run("Run stopped before it started", now(), runId);
        if (result.changes === 1) {
          this.skipPendingApps(runId, "Run stopped before it started");
          return "stopped" as const;
        }
        // The worker claimed it in between; fall through to the polled flag.
      }

      this.connection.prepare("UPDATE runs SET cancel_requested = 1 WHERE id = ?").run(runId);
      return "requested" as const;
    }).immediate();
  }

  isCancellationRequested(runId: string): boolean {
    const row = this.connection
      .prepare("SELECT cancel_requested FROM runs WHERE id = ?")
      .get(runId) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
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

  // ----- Slices ------------------------------------------------------------------------

  getSliceConfig(repositoryId: string): SliceConfig | null {
    const row = this.connection
      .prepare("SELECT slice_config_json FROM repositories WHERE id = ?")
      .get(repositoryId) as { slice_config_json: string | null } | undefined;
    return row?.slice_config_json ? normalizeSliceConfig(JSON.parse(row.slice_config_json)) : null;
  }

  setSliceConfig(repositoryId: string, config: SliceConfig): SliceConfig {
    const result = this.connection
      .prepare("UPDATE repositories SET slice_config_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), now(), repositoryId);
    if (result.changes === 0) throw new Error("Repository not found");
    return config;
  }

  private mapSliceBuild(row: SliceBuildRow): SliceBuild {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      status: row.status,
      requestedRef: row.requested_ref,
      useLocalWorkingTree: row.use_local_working_tree === 1,
      resolvedSha: row.resolved_sha,
      dirty: row.dirty === 1,
      error: row.error,
      sliceCount: row.slice_count,
      skipped: JSON.parse(row.skipped_json) as SliceBuild["skipped"],
      config: normalizeSliceConfig(JSON.parse(row.config_json)),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    };
  }

  getSliceBuild(id: string): SliceBuild | null {
    const row = this.connection.prepare("SELECT * FROM slice_builds WHERE id = ?").get(id) as SliceBuildRow | undefined;
    return row ? this.mapSliceBuild(row) : null;
  }

  listSliceBuilds(repositoryId: string, limit = 10): SliceBuild[] {
    const rows = this.connection
      .prepare("SELECT * FROM slice_builds WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(repositoryId, limit) as SliceBuildRow[];
    return rows.map((row) => this.mapSliceBuild(row));
  }

  /** Queues a slice build. Only one build per repository may be queued or running. */
  createSliceBuild(repositoryId: string, requestedRef?: string, useLocalWorkingTree = false): SliceBuild {
    const repository = this.getRepository(repositoryId);
    if (!repository) throw new Error("Repository not found");
    const config = this.getSliceConfig(repositoryId);
    if (!config) throw new Error("Set up slices for this repository before building them");
    if (useLocalWorkingTree && !repository.localPath) {
      throw new Error("This repository has no local checkout path configured");
    }
    const id = randomUUID();
    this.connection.transaction(() => {
      const active = this.connection
        .prepare(`SELECT id FROM slice_builds WHERE repository_id = ? AND status IN (${placeholders(activeSliceBuildStatuses)})`)
        .get(repositoryId, ...activeSliceBuildStatuses);
      if (active) throw new Error("This repository already has a slice build in progress");
      this.connection
        .prepare(`
          INSERT INTO slice_builds(id, repository_id, status, requested_ref, use_local_working_tree, config_json, created_at)
          VALUES (?, ?, 'queued', ?, ?, ?, ?)
        `)
        .run(
          id,
          repositoryId,
          useLocalWorkingTree ? "local working tree" : requestedRef ?? repository.defaultRef,
          useLocalWorkingTree ? 1 : 0,
          JSON.stringify(config),
          now()
        );
    }).immediate();
    return this.getSliceBuild(id)!;
  }

  claimNextSliceBuild(): SliceBuild | null {
    const id = this.connection.transaction(() => {
      const row = this.connection
        .prepare("SELECT id FROM slice_builds WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get() as { id: string } | undefined;
      if (!row) return null;
      const result = this.connection
        .prepare("UPDATE slice_builds SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), row.id);
      return result.changes === 1 ? row.id : null;
    }).immediate();
    return id ? this.getSliceBuild(id) : null;
  }

  setSliceBuildSource(id: string, resolvedSha: string, dirty: boolean): void {
    this.connection
      .prepare("UPDATE slice_builds SET resolved_sha = ?, dirty = ? WHERE id = ?")
      .run(resolvedSha, dirty ? 1 : 0, id);
  }

  finishSliceBuild(
    id: string,
    values: { status: Extract<SliceBuildStatus, "passed" | "failed">; error?: string | null; sliceCount?: number; skipped?: SliceBuild["skipped"] }
  ): void {
    this.connection
      .prepare("UPDATE slice_builds SET status = ?, error = ?, slice_count = ?, skipped_json = ?, finished_at = ? WHERE id = ?")
      .run(values.status, values.error ?? null, values.sliceCount ?? null, JSON.stringify(values.skipped ?? []), now(), id);
  }

  /** Fails builds a restarted worker can no longer finish. */
  markActiveSliceBuildsFailed(): string[] {
    const rows = this.connection.prepare("SELECT id FROM slice_builds WHERE status = 'running'").all() as Array<{ id: string }>;
    for (const { id } of rows) {
      this.finishSliceBuild(id, { status: "failed", error: "Worker restarted while this slice build was running" });
    }
    return rows.map((row) => row.id);
  }

  pruneSliceBuilds(repositoryId: string, keep: number): string[] {
    const rows = this.connection
      .prepare(`
        SELECT id FROM slice_builds WHERE repository_id = ? AND status NOT IN (${placeholders(activeSliceBuildStatuses)})
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      `)
      .all(repositoryId, ...activeSliceBuildStatuses, keep) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    this.connection.prepare(`DELETE FROM slice_builds WHERE id IN (${placeholders(ids)})`).run(...ids);
    return ids;
  }

  /**
   * Replaces every slice in the repository with a fresh build's result, then
   * seeds each slice's trend with a point from the current coverage snapshot so
   * the chart has a starting value before the next run.
   */
  replaceSlices(repositoryId: string, buildId: string, resolvedSha: string | null, slices: SliceInput[]): void {
    const timestamp = now();
    this.connection.transaction(() => {
      this.connection.prepare("DELETE FROM slices WHERE repository_id = ?").run(repositoryId);
      const insertSlice = this.connection.prepare(`
        INSERT INTO slices(
          id, repository_id, build_id, name, frontend_directory, backend_directory,
          resolved_sha, built_at, endpoint_count, file_count, endpoints_json, backends_json, unmatched_calls_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFile = this.connection.prepare(
        "INSERT OR IGNORE INTO slice_files(slice_id, file_path, backend_directory) VALUES (?, ?, ?)"
      );
      for (const slice of slices) {
        const sliceId = randomUUID();
        const files = new Set(slice.backends.flatMap((backend) => backend.files));
        insertSlice.run(
          sliceId,
          repositoryId,
          buildId,
          slice.name,
          slice.frontendDirectory,
          slice.backends[0]?.directory ?? "",
          resolvedSha,
          timestamp,
          slice.endpoints.length,
          files.size,
          JSON.stringify(slice.endpoints),
          JSON.stringify(slice.backends.map((backend) => ({ directory: backend.directory, endpointCount: backend.endpointCount }))),
          JSON.stringify(slice.unmatchedCalls ?? [])
        );
        for (const backend of slice.backends) {
          for (const file of backend.files) insertFile.run(sliceId, file, backend.directory);
        }
      }
      this.seedSliceHistory(repositoryId);
    })();
  }

  /** Records each slice's coverage from the snapshots it is currently measured against, once per run. */
  private seedSliceHistory(repositoryId: string): void {
    for (const slice of this.listSlices(repositoryId)) {
      if (slice.measuredFileCount === 0 || !slice.coverageCapturedAt) continue;
      const snapshot = this.connection
        .prepare(`
          SELECT s.run_id, s.resolved_sha, s.captured_at, h.requested_ref
          FROM coverage_snapshots s
          LEFT JOIN coverage_history h ON h.run_id = s.run_id AND h.app_name = s.app_name
          WHERE s.repository_id = ? AND s.captured_at = ? AND s.run_id IS NOT NULL
          LIMIT 1
        `)
        .get(repositoryId, slice.coverageCapturedAt) as
        | { run_id: string; resolved_sha: string | null; captured_at: string; requested_ref: string | null }
        | undefined;
      if (!snapshot) continue;
      this.insertSliceHistory({
        repositoryId,
        runId: snapshot.run_id,
        sliceName: slice.name,
        requestedRef: snapshot.requested_ref ?? "snapshot",
        resolvedSha: snapshot.resolved_sha,
        useLocalWorkingTree: false,
        dirty: false,
        recordedAt: snapshot.captured_at,
        coverage: slice.coverage,
        measuredFiles: slice.measuredFileCount,
        replace: false
      });
    }
  }

  private insertSliceHistory(values: {
    repositoryId: string;
    runId: string;
    sliceName: string;
    requestedRef: string;
    resolvedSha: string | null;
    useLocalWorkingTree: boolean;
    dirty: boolean;
    recordedAt: string;
    coverage: CoverageSummary;
    measuredFiles: number;
    replace: boolean;
  }): void {
    this.connection
      .prepare(`
        INSERT OR ${values.replace ? "REPLACE" : "IGNORE"} INTO slice_history(
          run_id, repository_id, slice_name, requested_ref, resolved_sha,
          use_local_working_tree, dirty, recorded_at, ${coverageMetricColumns}, measured_files
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        values.runId,
        values.repositoryId,
        values.sliceName,
        values.requestedRef,
        values.resolvedSha,
        values.useLocalWorkingTree ? 1 : 0,
        values.dirty ? 1 : 0,
        values.recordedAt,
        ...coverageMetricNames.flatMap((metric) => [
          values.coverage[metric]?.covered ?? null,
          values.coverage[metric]?.total ?? null
        ]),
        values.measuredFiles
      );
  }

  /** Per-file coverage from the current snapshots for files under one backend directory. */
  private snapshotFilesUnder(repositoryId: string, directory: string): Map<string, CoverageFileEntry> {
    const rows = this.connection
      .prepare(`
        SELECT s.app_name, f.* FROM coverage_files f
        JOIN coverage_snapshots s ON s.id = f.snapshot_id
        WHERE s.repository_id = ? AND substr(f.file_path, 1, ?) = ?
      `)
      .all(repositoryId, directory.length + 1, `${directory}/`) as CoverageFileRowRecord[];
    return new Map(rows.map((row) => [row.file_path, this.mapCoverageFileRow(row)] as const));
  }

  /**
   * Records one run's point for every slice that reaches a backend the run
   * tested. A slice spanning several backends takes this run's files for the
   * backends that ran and the current snapshot for the rest, so a run that
   * tested only one backend never drops the other from the total. Returns how
   * many slice points were written.
   */
  recordSliceHistory(values: {
    repositoryId: string;
    runId: string;
    requestedRef: string;
    resolvedSha: string | null;
    useLocalWorkingTree: boolean;
    dirty: boolean;
    /** This run's per-file coverage, keyed by app working directory. */
    filesByDirectory: Map<string, CoverageFileEntry[]>;
  }): number {
    const ranDirectories = Array.from(values.filesByDirectory.entries())
      .filter(([, files]) => files.length > 0)
      .map(([directory]) => directory);
    if (ranDirectories.length === 0) return 0;
    const slices = this.connection
      .prepare(`
        SELECT DISTINCT sl.id, sl.name FROM slices sl JOIN slice_files sf ON sf.slice_id = sl.id
        WHERE sl.repository_id = ? AND sf.backend_directory IN (${placeholders(ranDirectories)})
      `)
      .all(values.repositoryId, ...ranDirectories) as Array<{ id: string; name: string }>;
    if (slices.length === 0) return 0;

    const ranFiles = new Map<string, Map<string, CoverageFileEntry>>();
    for (const directory of ranDirectories) {
      ranFiles.set(directory, new Map(values.filesByDirectory.get(directory)!.map((file) => [file.path, file] as const)));
    }
    const snapshotFiles = new Map<string, Map<string, CoverageFileEntry>>();
    const lookup = (directory: string, filePath: string): CoverageFileEntry | undefined => {
      const ran = ranFiles.get(directory);
      if (ran) return ran.get(filePath);
      if (!snapshotFiles.has(directory)) snapshotFiles.set(directory, this.snapshotFilesUnder(values.repositoryId, directory));
      return snapshotFiles.get(directory)!.get(filePath);
    };

    const recordedAt = now();
    let written = 0;
    this.connection.transaction(() => {
      for (const slice of slices) {
        const files = this.connection
          .prepare("SELECT file_path, backend_directory FROM slice_files WHERE slice_id = ?")
          .all(slice.id) as Array<{ file_path: string; backend_directory: string }>;
        const measured = files.flatMap(({ file_path, backend_directory }) => {
          const file = lookup(backend_directory, file_path);
          return file ? [file] : [];
        });
        if (measured.length === 0) continue;
        this.insertSliceHistory({
          repositoryId: values.repositoryId,
          runId: values.runId,
          sliceName: slice.name,
          requestedRef: values.requestedRef,
          resolvedSha: values.resolvedSha,
          useLocalWorkingTree: values.useLocalWorkingTree,
          dirty: values.dirty,
          recordedAt,
          coverage: sumCoverage(measured),
          measuredFiles: measured.length,
          replace: true
        });
        written += 1;
      }
    })();
    return written;
  }

  private sumsToCoverage(row: MetricSums, measured: number): CoverageSummary {
    return {
      lines: measured ? percentMetric(row.lines_covered, row.lines_total) : null,
      statements: measured ? percentMetric(row.statements_covered, row.statements_total) : null,
      functions: measured ? percentMetric(row.functions_covered, row.functions_total) : null,
      branches: measured ? percentMetric(row.branches_covered, row.branches_total) : null
    };
  }

  /**
   * Current slice coverage, summed from the coverage snapshots in the same
   * repository, per slice and backend. Each slice file joins only snapshot
   * rows under its own backend directory, so another app's report that
   * happens to list the same path cannot count twice.
   */
  private sliceBackendRows(repositoryId: string, sliceName?: string) {
    const sums = coverageMetricNames
      .flatMap((metric) => [`SUM(f.${metric}_covered) AS ${metric}_covered`, `SUM(f.${metric}_total) AS ${metric}_total`])
      .join(", ");
    return this.connection
      .prepare(`
        SELECT sl.id AS slice_id, sf.backend_directory, COUNT(sf.file_path) AS file_count,
          COUNT(f.file_path) AS measured_files, ${sums},
          MAX(cs.captured_at || '|' || COALESCE(cs.resolved_sha, '')) AS coverage_source
        FROM slices sl
        JOIN slice_files sf ON sf.slice_id = sl.id
        LEFT JOIN (coverage_files f JOIN coverage_snapshots cs ON cs.id = f.snapshot_id)
          ON f.file_path = sf.file_path
          AND cs.repository_id = sl.repository_id
          AND substr(f.file_path, 1, length(sf.backend_directory) + 1) = sf.backend_directory || '/'
        WHERE sl.repository_id = ? ${sliceName ? "AND sl.name = ? COLLATE NOCASE" : ""}
        GROUP BY sl.id, sf.backend_directory
      `)
      .all(...(sliceName ? [repositoryId, sliceName] : [repositoryId])) as Array<
      MetricSums & { slice_id: string; backend_directory: string; file_count: number; measured_files: number; coverage_source: string | null }
    >;
  }

  private sliceRecords(repositoryId: string, sliceName?: string): Array<{ row: SliceRow; slice: Slice }> {
    const rows = this.connection
      .prepare(`
        SELECT * FROM slices WHERE repository_id = ? ${sliceName ? "AND name = ? COLLATE NOCASE" : ""}
        ORDER BY name COLLATE NOCASE ASC
      `)
      .all(...(sliceName ? [repositoryId, sliceName] : [repositoryId])) as SliceRow[];
    const backendRows = this.sliceBackendRows(repositoryId, sliceName);

    return rows.map((row) => {
      const declared = JSON.parse(row.backends_json) as Array<{ directory: string; endpointCount: number }>;
      const mine = backendRows.filter((backend) => backend.slice_id === row.id);
      const totals = {} as MetricSums;
      for (const metric of coverageMetricNames) {
        for (const part of ["covered", "total"] as const) {
          const key = `${metric}_${part}` as const;
          const values = mine.map((backend) => backend[key]).filter((value): value is number => value !== null);
          totals[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
        }
      }
      const measured = mine.reduce((sum, backend) => sum + backend.measured_files, 0);
      const source = mine
        .map((backend) => backend.coverage_source)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      const [capturedAt, sha] = source ? source.split("|") : [null, null];
      const backends: SliceBackendSummary[] = declared.map((backend) => {
        const stats = mine.find((candidate) => candidate.backend_directory === backend.directory);
        return {
          directory: backend.directory,
          endpointCount: backend.endpointCount,
          fileCount: stats?.file_count ?? 0,
          measuredFileCount: stats?.measured_files ?? 0,
          coverage: stats ? this.sumsToCoverage(stats, stats.measured_files) : { lines: null, statements: null, functions: null, branches: null }
        };
      });
      return {
        row,
        slice: {
          name: row.name,
          frontendDirectory: row.frontend_directory,
          buildId: row.build_id,
          resolvedSha: row.resolved_sha,
          builtAt: row.built_at,
          endpointCount: row.endpoint_count,
          fileCount: row.file_count,
          measuredFileCount: measured,
          coverage: this.sumsToCoverage(totals, measured),
          coverageCapturedAt: capturedAt || null,
          coverageSha: sha || null,
          backends,
          unmatchedCallCount: (JSON.parse(row.unmatched_calls_json) as unknown[]).length
        }
      };
    });
  }

  listSlices(repositoryId: string): Slice[] {
    return this.sliceRecords(repositoryId).map(({ slice }) => slice);
  }

  getSlice(repositoryId: string, name: string): SliceDetail | null {
    const record = this.sliceRecords(repositoryId, name)[0];
    if (!record) return null;
    const fallbackBackend = record.row.backend_directory;
    return {
      ...record.slice,
      endpoints: (JSON.parse(record.row.endpoints_json) as SliceEndpoint[]).map((endpoint) => ({
        ...endpoint,
        backendDirectory: endpoint.backendDirectory ?? fallbackBackend
      })),
      unmatchedCalls: JSON.parse(record.row.unmatched_calls_json) as SliceUnmatchedCall[]
    };
  }

  /**
   * Every coverage file matching the filters, unpaged, with the slices that
   * include it. Used for CSV and JSON exports.
   */
  exportCoverageFiles(repositoryId: string, query: Omit<CoverageFileQuery, "limit" | "offset"> = {}): CoverageExportRow[] {
    const membership = new Map<string, string[]>();
    const rows = this.connection
      .prepare(`
        SELECT sf.file_path, sl.name FROM slice_files sf JOIN slices sl ON sl.id = sf.slice_id
        WHERE sl.repository_id = ? ORDER BY sl.name COLLATE NOCASE
      `)
      .all(repositoryId) as Array<{ file_path: string; name: string }>;
    for (const row of rows) membership.set(row.file_path, [...(membership.get(row.file_path) ?? []), row.name]);

    const files: CoverageExportRow[] = [];
    for (let offset = 0; ; offset += 1_000) {
      const page = this.queryCoverageFiles(repositoryId, { ...query, limit: 1_000, offset });
      for (const file of page.files) files.push({ ...file, slices: membership.get(file.path) ?? [] });
      if (offset + page.files.length >= page.total || page.files.length === 0) break;
    }
    return files;
  }

  /** Slice trend points, shaped like app coverage history with the slice name as the app. */
  listSliceHistory(repositoryId: string): CoverageHistoryEntry[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM slice_history WHERE repository_id = ?
        ORDER BY recorded_at ASC, run_id ASC, slice_name COLLATE NOCASE ASC
      `)
      .all(repositoryId) as SliceHistoryRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      appName: row.slice_name,
      requestedRef: row.requested_ref,
      resolvedSha: row.resolved_sha,
      useLocalWorkingTree: row.use_local_working_tree === 1,
      dirty: row.dirty === 1,
      recordedAt: row.recorded_at,
      coverage: {
        lines: percentMetric(row.lines_covered, row.lines_total),
        statements: percentMetric(row.statements_covered, row.statements_total),
        functions: percentMetric(row.functions_covered, row.functions_total),
        branches: percentMetric(row.branches_covered, row.branches_total)
      },
      tests: null
    }));
  }

}
