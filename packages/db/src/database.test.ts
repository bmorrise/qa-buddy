import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInput } from "@qa-buddy/shared";
import { QaBuddyDatabase } from "./database.js";

const input: RepositoryInput = {
  name: "Example platform",
  githubUrl: "https://github.com/example/platform.git",
  defaultRef: "main",
  additionalWorkspaces: [],
  excludedWorkspaces: [],
  runnerImage: "node:22-bookworm",
  setupCommand: "npm ci",
  buildCommand: "npm run build",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: ["NPM_TOKEN"],
  autoDetect: false,
  apps: [
    {
      name: "Web",
      workingDirectory: "apps/web",
      testCommand: "npm test -- --coverage",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "apps/web/coverage/coverage-summary.json"
    },
    {
      name: "API",
      workingDirectory: "apps/api",
      testCommand: "npm test -- --coverage",
      coverageFormat: "lcov",
      coveragePath: "apps/api/coverage/lcov.info"
    }
  ]
};

describe("QaBuddyDatabase", () => {
  let directory: string;
  let database: QaBuddyDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-db-"));
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists repositories and immutable run snapshots", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "feature/test");
    database.updateRepository(repository.id, { ...input, name: "Renamed platform", apps: [input.apps[0]!] });

    expect(database.getRepository(repository.id)?.name).toBe("Renamed platform");
    expect(database.getRun(run.id)?.configurationSnapshot.name).toBe("Example platform");
    expect(database.getRun(run.id)?.configurationSnapshot.buildCommand).toBe("npm run build");
    expect(database.getRun(run.id)?.configurationSnapshot.testWorkerLimit).toBe(2);
    expect(database.getRun(run.id)?.appRuns).toHaveLength(2);
  });

  it("creates a run for only the selected configured apps", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, undefined, ["API"]);

    expect(run.selectedApps).toEqual(["API"]);
    expect(run.configurationSnapshot.apps).toHaveLength(2);
    expect(run.configurationSnapshot.selectedApps).toEqual(["API"]);
    expect(run.appRuns.map((app) => app.name)).toEqual(["API"]);
  });

  it("stores run-specific apps discovered from a pnpm workspace", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id);
    expect(run.appRuns).toHaveLength(0);

    const detected = database.setDetectedApps(run.id, [input.apps[0]!]);
    expect(detected.appRuns).toHaveLength(1);
    expect(detected.configurationSnapshot.apps[0]?.name).toBe("Web");
    expect(database.getRepository(repository.id)?.apps).toHaveLength(0);
  });

  it("filters detected apps to the immutable run selection", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id, undefined, ["API"]);
    const detected = database.setDetectedApps(run.id, input.apps);

    expect(detected.configurationSnapshot.apps).toEqual(input.apps);
    expect(detected.selectedApps).toEqual(["API"]);
    expect(detected.appRuns.map((app) => app.name)).toEqual(["API"]);
    expect(database.getRepositoryDetail(repository.id)?.selectableApps).toEqual(input.apps);
  });

  it("rejects selected apps that are absent from the requested ref", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id, undefined, ["Missing"]);

    expect(() => database.setDetectedApps(run.id, input.apps)).toThrow(/not detected.*Missing/);
  });

  it("claims runs sequentially and prevents duplicate active runs per repository", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id);
    expect(() => database.createRun(repository.id)).toThrow(/already has/);
    expect(database.claimNextRun()?.id).toBe(run.id);
    expect(database.claimNextRun()).toBeNull();
  });

  it("records app coverage and run outcomes", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id);
    database.claimNextRun();
    const app = run.appRuns[0]!;
    database.startAppRun(app.id);
    database.finishAppRun(app.id, {
      status: "passed",
      exitCode: 0,
      coverage: {
        lines: { covered: 9, total: 10, percent: 90 },
        statements: { covered: 9, total: 10, percent: 90 },
        functions: { covered: 3, total: 4, percent: 75 },
        branches: { covered: 2, total: 4, percent: 50 }
      },
      testResults: {
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        todo: 0,
        testCases: [
          {
            name: "works",
            fullName: "suite works",
            ancestorTitles: ["suite"],
            filePath: "src/example.test.ts",
            status: "passed",
            durationMs: 4,
            failureMessage: null
          },
          {
            name: "fails",
            fullName: "suite fails",
            ancestorTitles: ["suite"],
            filePath: "src/example.test.ts",
            status: "failed",
            durationMs: 2,
            failureMessage: "Expected true"
          }
        ]
      }
    });
    database.updateRun(run.id, { status: "passed", finished: true });

    const result = database.getRun(run.id)!;
    expect(result.status).toBe("passed");
    expect(result.appRuns[0]?.coverage?.lines?.percent).toBe(90);
    expect(result.appRuns[0]?.testResults?.failed).toBe(1);
    expect(result.appRuns[0]?.testResults?.testCases[1]?.failureMessage).toBe("Expected true");
    expect(result.finishedAt).not.toBeNull();
  });

  it("interrupts active work but leaves queued jobs available", () => {
    const first = database.createRepository(input);
    const second = database.createRepository({
      ...input,
      name: "Second",
      githubUrl: "https://github.com/example/second.git"
    });
    const active = database.createRun(first.id);
    database.claimNextRun();
    const queued = database.createRun(second.id);

    expect(database.markActiveRunsInterrupted()).toEqual([active.id]);
    expect(database.getRun(active.id)?.status).toBe("interrupted");
    expect(database.getRun(queued.id)?.status).toBe("queued");
  });

  it("reports each app's most recent passing durations, newest first", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const repository = database.createRepository(input);
      let clock = Date.parse("2026-10-01T00:00:00.000Z");
      const runApps = (durations: Record<string, { minutes: number; status: "passed" | "failed" }>) => {
        const run = database.createRun(repository.id);
        database.claimNextRun();
        for (const app of run.appRuns) {
          const outcome = durations[app.name];
          if (!outcome) continue;
          vi.setSystemTime(clock);
          database.startAppRun(app.id);
          clock += outcome.minutes * 60_000;
          vi.setSystemTime(clock);
          database.finishAppRun(app.id, { status: outcome.status, exitCode: outcome.status === "passed" ? 0 : 1 });
        }
        database.updateRun(run.id, { status: "passed", finished: true });
      };

      runApps({ Web: { minutes: 3, status: "passed" }, API: { minutes: 10, status: "passed" } });
      runApps({ Web: { minutes: 4, status: "passed" }, API: { minutes: 99, status: "failed" } });
      runApps({ Web: { minutes: 5, status: "passed" } });

      const durations = database.recentPassingAppDurations(repository.id, 2);
      expect(durations.get("Web")).toEqual([300_000, 240_000]);
      // Failed runs say nothing about how long a healthy run takes.
      expect(durations.get("API")).toEqual([600_000]);
      expect(database.recentPassingAppDurations("missing", 2).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the latest completed run separate from in-progress and partial runs", () => {
    const repository = database.createRepository(input);
    expect(database.getRepository(repository.id)?.latestCompletedRun).toBeNull();

    const failed = database.createRun(repository.id);
    database.claimNextRun();
    database.updateRun(failed.id, { status: "failed", finished: true });
    const interrupted = database.createRun(repository.id);
    database.claimNextRun();
    database.updateRun(interrupted.id, { status: "interrupted", finished: true });
    const active = database.createRun(repository.id);
    database.claimNextRun();

    const result = database.getRepository(repository.id)!;
    expect(result.latestRun?.id).toBe(active.id);
    expect(result.latestCompletedRun?.id).toBe(failed.id);
  });

  function finishRunWithCoverage(repositoryId: string, status: "passed" | "failed" | "interrupted", covered: number) {
    const run = database.createRun(repositoryId);
    database.claimNextRun();
    database.finishAppRun(run.appRuns[0]!.id, {
      status: "passed",
      exitCode: 0,
      coverage: {
        lines: { covered, total: 10, percent: covered * 10 },
        statements: null,
        functions: null,
        branches: { covered: 1, total: 4, percent: 25 }
      },
      testResults: { total: 3, passed: 3, failed: 0, skipped: 0, todo: 0, testCases: [] }
    });
    database.updateRun(run.id, { status, finished: true });
    return run;
  }

  it("records coverage history for completed runs and keeps it after pruning", () => {
    const repository = database.createRepository(input);
    const first = finishRunWithCoverage(repository.id, "passed", 4);
    finishRunWithCoverage(repository.id, "interrupted", 9);
    const third = finishRunWithCoverage(repository.id, "failed", 6);

    database.pruneRuns(repository.id, 1);
    const history = database.listCoverageHistory(repository.id);
    // Runs finish within the same millisecond here, so compare without order.
    expect(history.map((entry) => entry.runId).sort()).toEqual([first.id, third.id].sort());
    expect(history.find((entry) => entry.runId === third.id)).toMatchObject({
      appName: "Web",
      coverage: { lines: { covered: 6, total: 10, percent: 60 }, statements: null, branches: { percent: 25 } },
      tests: { total: 3, passed: 3, failed: 0 }
    });

    database.deleteRepository(repository.id);
    expect(database.listCoverageHistory(repository.id)).toEqual([]);
  });

  it("backfills coverage history from runs completed before the table existed", () => {
    const repository = database.createRepository(input);
    const run = finishRunWithCoverage(repository.id, "passed", 7);
    database.connection.exec("DROP TABLE coverage_history; DELETE FROM schema_migrations WHERE version = 13;");
    database.close();
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));

    expect(database.listCoverageHistory(repository.id)).toMatchObject([{ runId: run.id, coverage: { lines: { percent: 70 } } }]);
  });

  it("prunes older history and blocks deletion during active work", () => {
    const repository = database.createRepository(input);
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = database.createRun(repository.id);
      runIds.push(run.id);
      database.claimNextRun();
      database.updateRun(run.id, { status: "passed", finished: true });
    }
    expect(database.pruneRuns(repository.id, 2)).toEqual([runIds[0]]);
    expect(database.listRuns(repository.id, 20)).toHaveLength(2);

    database.createRun(repository.id);
    expect(database.deleteRepository(repository.id)).toMatchObject({ deleted: false, active: true });
  });

  it("records local working tree runs and refuses them without a configured checkout path", () => {
    const remoteOnly = database.createRepository(input);
    expect(() => database.createRun(remoteOnly.id, "main", undefined, true)).toThrow(
      "no local checkout path configured"
    );
    expect(database.createRun(remoteOnly.id, "main").useLocalWorkingTree).toBe(false);

    const local = database.createRepository({
      ...input,
      name: "Local platform",
      githubUrl: "https://github.com/example/local.git",
      localPath: "platform"
    });
    expect(database.getRepository(local.id)?.localPath).toBe("platform");

    const run = database.createRun(local.id, "main", undefined, true);
    expect(run.useLocalWorkingTree).toBe(true);
    expect(run.dirty).toBe(false);
    expect(run.configurationSnapshot.localPath).toBe("platform");

    database.updateRun(run.id, { resolvedSha: "abc123", dirty: true });
    expect(database.getRun(run.id)?.dirty).toBe(true);
    expect(database.getRun(run.id)?.resolvedSha).toBe("abc123");
  });

  const coverageFile = (
    path: string,
    lines: [number, number],
    branches: [number, number]
  ) => ({
    path,
    lines: { covered: lines[0], total: lines[1], percent: null },
    statements: null,
    functions: { covered: 1, total: 2, percent: null },
    branches: { covered: branches[0], total: branches[1], percent: null }
  });

  const summary = {
    lines: { covered: 5, total: 10, percent: 50 },
    statements: null,
    functions: { covered: 1, total: 2, percent: 50 },
    branches: { covered: 1, total: 4, percent: 25 }
  };

  function seedSnapshot(repositoryId: string, appName = "Web") {
    database.replaceCoverageSnapshot(repositoryId, appName, {
      runId: "run-1",
      resolvedSha: "abc123",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json",
      summary,
      files: [
        coverageFile("src/well-tested.ts", [10, 10], [8, 8]),
        coverageFile("src/partial.ts", [5, 10], [2, 8]),
        coverageFile("src/untested.ts", [0, 20], [0, 12]),
        coverageFile("src/types.ts", [0, 0], [0, 0])
      ]
    });
  }

  it("stores a per-app coverage snapshot and replaces it in place", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);
    seedSnapshot(repository.id, "API");

    const snapshots = database.listCoverageSnapshots(repository.id);
    expect(snapshots.map((snapshot) => snapshot.appName)).toEqual(["API", "Web"]);
    expect(snapshots[0]?.fileCount).toBe(4);
    expect(snapshots[0]?.resolvedSha).toBe("abc123");
    expect(snapshots[0]?.summary.branches).toEqual({ covered: 1, total: 4, percent: 25 });

    database.replaceCoverageSnapshot(repository.id, "Web", {
      runId: "run-2",
      resolvedSha: "def456",
      coverageFormat: "lcov",
      coveragePath: "coverage/lcov.info",
      summary,
      files: [coverageFile("src/only.ts", [1, 2], [1, 2])]
    });

    const replaced = database.listCoverageSnapshots(repository.id);
    expect(replaced).toHaveLength(2);
    const web = replaced.find((snapshot) => snapshot.appName === "Web");
    expect(web?.fileCount).toBe(1);
    expect(web?.resolvedSha).toBe("def456");
    expect(database.queryCoverageFiles(repository.id, { appName: "Web" }).total).toBe(1);
  });

  it("ranks the weakest files first and treats zero-denominator files as unmeasured", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);

    const branches = database.queryCoverageFiles(repository.id, { metric: "branches" });
    expect(branches.files.map((file) => file.path)).toEqual([
      "src/untested.ts",
      "src/partial.ts",
      "src/well-tested.ts",
      "src/types.ts"
    ]);
    expect(branches.files[0]?.branches?.percent).toBe(0);
    // A file with a zero denominator has no measurable coverage and sorts last.
    expect(branches.files[3]?.branches?.percent).toBeNull();

    const belowHalf = database.queryCoverageFiles(repository.id, { metric: "branches", maxPercent: 50 });
    expect(belowHalf.files.map((file) => file.path)).toEqual(["src/untested.ts", "src/partial.ts"]);
    expect(belowHalf.total).toBe(2);

    const zeroOnly = database.queryCoverageFiles(repository.id, { metric: "branches", maxPercent: 0 });
    expect(zeroOnly.files.map((file) => file.path)).toEqual(["src/untested.ts"]);
  });

  it("filters by path and pages through results", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);

    expect(database.queryCoverageFiles(repository.id, { search: "untested" }).files).toHaveLength(1);
    expect(database.queryCoverageFiles(repository.id, { search: "src/" }).total).toBe(4);
    expect(database.queryCoverageFiles(repository.id, { search: "%" }).total).toBe(0);

    const firstPage = database.queryCoverageFiles(repository.id, { metric: "branches", limit: 2 });
    expect(firstPage.files).toHaveLength(2);
    expect(firstPage.total).toBe(4);

    const secondPage = database.queryCoverageFiles(repository.id, { metric: "branches", limit: 2, offset: 2 });
    expect(secondPage.files.map((file) => file.path)).toEqual(["src/well-tested.ts", "src/types.ts"]);
  });

  it("keeps the snapshot when the run that produced it is pruned from history", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");
    database.updateRun(run.id, { status: "passed", finished: true });
    database.replaceCoverageSnapshot(repository.id, "Web", {
      runId: run.id,
      resolvedSha: "abc123",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json",
      summary,
      files: [coverageFile("src/only.ts", [1, 2], [1, 2])]
    });

    expect(database.pruneRuns(repository.id, 0)).toContain(run.id);
    expect(database.getRun(run.id)).toBeNull();

    const snapshots = database.listCoverageSnapshots(repository.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.runId).toBe(run.id);
    expect(database.queryCoverageFiles(repository.id).total).toBe(1);
  });

  it("removes snapshots when the repository is deleted", () => {
    const repository = database.createRepository(input);
    seedSnapshot(repository.id);
    database.deleteRepository(repository.id);
    expect(database.listCoverageSnapshots(repository.id)).toHaveLength(0);
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM coverage_files").get()
    ).toEqual({ count: 0 });
  });

  it("stops a queued run outright without marking it failed", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");

    expect(database.requestRunCancellation(run.id)).toBe("stopped");

    const stopped = database.getRun(run.id);
    expect(stopped?.status).toBe("interrupted");
    expect(stopped?.cancelRequested).toBe(true);
    expect(stopped?.finishedAt).not.toBeNull();
    expect(stopped?.appRuns.every((app) => app.status === "skipped")).toBe(true);
    // The repository is free again immediately.
    expect(() => database.createRun(repository.id, "main")).not.toThrow();
  });

  it("flags a claimed run for the worker rather than ending it directly", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");
    database.claimNextRun();

    expect(database.isCancellationRequested(run.id)).toBe(false);
    expect(database.requestRunCancellation(run.id)).toBe("requested");
    expect(database.isCancellationRequested(run.id)).toBe(true);

    // Still active: only the worker may move a claimed run to a terminal state.
    const claimed = database.getRun(run.id);
    expect(claimed?.status).toBe("cloning");
    expect(claimed?.finishedAt).toBeNull();
  });

  it("reports runs that cannot be stopped", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "main");
    database.updateRun(run.id, { status: "passed", finished: true });

    expect(database.requestRunCancellation(run.id)).toBe("already_finished");
    expect(database.requestRunCancellation("missing-run")).toBe("not_found");
    expect(database.getRun(run.id)?.status).toBe("passed");
  });

  it("saves, renames, re-points, and deletes application groups", () => {
    const repository = database.createRepository(input);

    const group = database.createAppGroup(repository.id, {
      name: "Riverside set",
      appNames: ["@idplans-platform/riverside", "@idplans-platform/riverside-api"]
    });
    expect(group.appNames).toHaveLength(2);
    expect(database.getRepositoryDetail(repository.id)?.appGroups).toHaveLength(1);

    const renamed = database.updateAppGroup(group.id, { name: "Riverside" });
    expect(renamed?.name).toBe("Riverside");
    expect(renamed?.appNames).toEqual(group.appNames);

    const repointed = database.updateAppGroup(group.id, { appNames: ["@idplans-platform/scout"] });
    expect(repointed?.name).toBe("Riverside");
    expect(repointed?.appNames).toEqual(["@idplans-platform/scout"]);

    expect(database.deleteAppGroup(group.id)).toBe(true);
    expect(database.listAppGroups(repository.id)).toEqual([]);
    expect(database.deleteAppGroup(group.id)).toBe(false);
  });

  it("keeps group names unique per repository but allows reuse across them", () => {
    const first = database.createRepository(input);
    const second = database.createRepository({
      ...input,
      name: "Second",
      githubUrl: "https://github.com/example/second.git"
    });

    database.createAppGroup(first.id, { name: "Nightly", appNames: ["Web"] });
    expect(() => database.createAppGroup(first.id, { name: "nightly", appNames: ["API"] })).toThrow(
      "already exists"
    );
    expect(() => database.createAppGroup(second.id, { name: "Nightly", appNames: ["Web"] })).not.toThrow();

    const other = database.createAppGroup(first.id, { name: "Weekly", appNames: ["API"] });
    expect(() => database.updateAppGroup(other.id, { name: "Nightly" })).toThrow("already exists");
  });

  it("stores an optional coverage goal on the repository", () => {
    const repository = database.createRepository(input);
    expect(repository.coverageGoal).toBeNull();
    expect(database.updateRepository(repository.id, { ...input, coverageGoal: 70 })?.coverageGoal).toBe(70);
    expect(database.updateRepository(repository.id, { ...input, coverageGoal: null })?.coverageGoal).toBeNull();
  });

  it("stores excluded workspaces and hides them from selectable apps before the next run", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    expect(repository.excludedWorkspaces).toEqual([]);
    const run = database.createRun(repository.id);
    database.setDetectedApps(run.id, input.apps);

    const updated = database.updateRepository(repository.id, {
      ...input,
      autoDetect: true,
      apps: [],
      excludedWorkspaces: ["apps/api"]
    });
    expect(updated?.excludedWorkspaces).toEqual(["apps/api"]);
    expect(database.getRepositoryDetail(repository.id)?.selectableApps.map((app) => app.name)).toEqual(["Web"]);
  });

  it("appends new groups and reorders them only with the complete list", () => {
    const repository = database.createRepository(input);
    const zebra = database.createAppGroup(repository.id, { name: "Zebra", appNames: ["Web"] });
    const alpha = database.createAppGroup(repository.id, { name: "Alpha", appNames: ["API"] });
    expect(database.listAppGroups(repository.id).map((group) => group.name)).toEqual(["Zebra", "Alpha"]);

    expect(database.reorderAppGroups(repository.id, [alpha.id, zebra.id])?.map((group) => group.name)).toEqual(["Alpha", "Zebra"]);
    expect(database.reorderAppGroups(repository.id, [alpha.id])).toBeNull();
    expect(database.reorderAppGroups(repository.id, [alpha.id, "someone-else"])).toBeNull();
    expect(database.listAppGroups(repository.id).map((group) => group.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("orders existing groups alphabetically when positions are introduced", () => {
    const repository = database.createRepository(input);
    database.createAppGroup(repository.id, { name: "zebra", appNames: ["Web"] });
    database.createAppGroup(repository.id, { name: "Alpha", appNames: ["API"] });
    database.createAppGroup(repository.id, { name: "middle", appNames: ["API"] });
    database.connection.exec("ALTER TABLE app_groups DROP COLUMN position; DELETE FROM schema_migrations WHERE version = 14;");
    database.close();
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));

    expect(database.listAppGroups(repository.id).map((group) => group.name)).toEqual(["Alpha", "middle", "zebra"]);
  });

  it("removes groups when the repository is deleted", () => {
    const repository = database.createRepository(input);
    database.createAppGroup(repository.id, { name: "Nightly", appNames: ["Web"] });
    database.deleteRepository(repository.id);
    expect(database.listAppGroups(repository.id)).toEqual([]);
  });
});
