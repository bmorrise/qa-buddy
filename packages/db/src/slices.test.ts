import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageFileEntry, RepositoryInput, SliceConfig } from "@qa-buddy/shared";
import { QaBuddyDatabase, sumCoverage, type SliceInput } from "./database.js";

const input: RepositoryInput = {
  name: "Platform",
  githubUrl: "https://github.com/example/platform.git",
  defaultRef: "main",
  additionalWorkspaces: [],
  excludedWorkspaces: [],
  runnerImage: "node:22-bookworm",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: true,
  apps: []
};

const config: SliceConfig = {
  backends: [
    { directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] },
    { directory: "apps/legacy", framework: "express", clientPackage: null, rootModule: null, entryFile: "app.js", baseUrlNames: ["LEGACY_HOST"] }
  ],
  frontendDirectories: []
};

const metric = (covered: number, total: number) => ({ covered, total, percent: total ? Math.round((covered / total) * 1000) / 10 : null });

function file(pathName: string, covered: number, total: number): CoverageFileEntry {
  return {
    path: pathName,
    lines: metric(covered, total),
    statements: metric(covered, total),
    functions: metric(covered, total),
    branches: metric(covered, total)
  };
}

/** Inspect reaches both backends; scout only the NestJS one. */
const inspectSlice: SliceInput = {
  name: "inspect",
  frontendDirectory: "apps/inspect",
  endpoints: [
    { backendDirectory: "apps/api", httpMethod: "get", path: "/inspection", controller: "InspectionController", methodKey: "findAll", file: "apps/api/src/inspection.controller.ts", clientNames: ["useFindAll"] },
    { backendDirectory: "apps/legacy", httpMethod: "post", path: "/login", controller: "login", methodKey: "", file: "apps/legacy/routes/login.js", clientNames: ["apps/inspect/src/login.ts:4"] }
  ],
  backends: [
    { directory: "apps/api", endpointCount: 1, files: ["apps/api/src/inspection.controller.ts", "apps/api/src/shared.ts", "apps/api/src/types.ts"] },
    { directory: "apps/legacy", endpointCount: 1, files: ["apps/legacy/routes/login.js", "apps/legacy/libs/users.js"] }
  ],
  unmatchedCalls: [{ backendDirectory: "apps/legacy", site: "apps/inspect/src/odd.ts:9", method: "put", path: "/mystery/{}" }]
};

const scoutSlice: SliceInput = {
  name: "scout",
  frontendDirectory: "apps/scout",
  endpoints: [],
  backends: [
    { directory: "apps/api", endpointCount: 0, files: ["apps/api/src/scout.controller.ts", "apps/api/src/shared.ts"] },
    { directory: "apps/legacy", endpointCount: 0, files: [] }
  ]
};

const apiFiles = [
  file("apps/api/src/inspection.controller.ts", 2, 10),
  file("apps/api/src/shared.ts", 6, 10),
  file("apps/api/src/scout.controller.ts", 9, 10),
  file("apps/api/src/unrelated.ts", 0, 50)
];
const legacyFiles = [file("apps/legacy/routes/login.js", 1, 10), file("apps/legacy/libs/users.js", 3, 10)];

describe("slices", () => {
  let directory: string;
  let database: QaBuddyDatabase;
  let repositoryId: string;

  const snapshot = (appName: string, runId: string, files: CoverageFileEntry[]): void =>
    database.replaceCoverageSnapshot(repositoryId, appName, {
      runId,
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: null,
      summary: sumCoverage(files),
      files
    });

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-slices-db-"));
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
    repositoryId = database.createRepository(input).id;
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a recipe, queues one build at a time, and records the outcome", () => {
    expect(() => database.createSliceBuild(repositoryId)).toThrow("Set up slices");
    database.setSliceConfig(repositoryId, config);
    expect(database.getSliceConfig(repositoryId)).toEqual(config);

    const build = database.createSliceBuild(repositoryId);
    expect(build).toMatchObject({ status: "queued", requestedRef: "main", config });
    expect(() => database.createSliceBuild(repositoryId, "develop")).toThrow("already has a slice build");

    const claimed = database.claimNextSliceBuild();
    expect(claimed?.id).toBe(build.id);
    expect(database.claimNextSliceBuild()).toBeNull();

    database.setSliceBuildSource(build.id, "abc123", false);
    database.finishSliceBuild(build.id, {
      status: "passed",
      sliceCount: 2,
      skipped: [{ frontendDirectory: "apps/docs", reason: "no entry point" }]
    });
    expect(database.getSliceBuild(build.id)).toMatchObject({
      status: "passed",
      resolvedSha: "abc123",
      sliceCount: 2,
      skipped: [{ frontendDirectory: "apps/docs", reason: "no entry point" }]
    });
    expect(database.createSliceBuild(repositoryId, "develop").requestedRef).toBe("develop");
  });

  it("upgrades a single-backend recipe saved before backends were a list", () => {
    database.connection
      .prepare("UPDATE repositories SET slice_config_json = ? WHERE id = ?")
      .run(JSON.stringify({ backendDirectory: "apps/api", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", frontendDirectories: ["apps/inspect"] }), repositoryId);
    expect(database.getSliceConfig(repositoryId)).toEqual({
      backends: [{ directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] }],
      frontendDirectories: ["apps/inspect"]
    });
  });

  it("fails running builds after a worker restart and prunes old ones", () => {
    database.setSliceConfig(repositoryId, config);
    const first = database.createSliceBuild(repositoryId);
    database.claimNextSliceBuild();
    expect(database.markActiveSliceBuildsFailed()).toEqual([first.id]);
    expect(database.getSliceBuild(first.id)).toMatchObject({ status: "failed", error: expect.stringContaining("restarted") });

    const second = database.createSliceBuild(repositoryId);
    database.claimNextSliceBuild();
    database.finishSliceBuild(second.id, { status: "passed", sliceCount: 1 });
    expect(database.pruneSliceBuilds(repositoryId, 1)).toEqual([first.id]);
    expect(database.listSliceBuilds(repositoryId).map((build) => build.id)).toEqual([second.id]);
  });

  it("sums coverage across both backends and breaks it down per backend", () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice, scoutSlice]);
    const unmeasured = database.listSlices(repositoryId);
    expect(unmeasured.map((slice) => [slice.name, slice.fileCount, slice.measuredFileCount])).toEqual([
      ["inspect", 5, 0],
      ["scout", 2, 0]
    ]);
    expect(unmeasured[0]!.coverage.lines).toBeNull();
    expect(database.listSliceHistory(repositoryId)).toEqual([]);

    snapshot("@acme/api", "run-1", apiFiles);
    snapshot("@acme/legacy", "run-1", legacyFiles);
    // Another app's report listing a path outside the backends must not count.
    snapshot("@acme/inspect", "run-1", [file("apps/inspect/src/main.tsx", 1, 1)]);

    const [inspect, scout] = database.listSlices(repositoryId);
    expect(inspect).toMatchObject({ measuredFileCount: 4, coverageSha: "def456", endpointCount: 2, unmatchedCallCount: 1 });
    // apps/api: 8/20, apps/legacy: 4/20.
    expect(inspect!.coverage.lines).toEqual({ covered: 12, total: 40, percent: 30 });
    expect(inspect!.backends.map((backend) => [backend.directory, backend.endpointCount, backend.fileCount, backend.measuredFileCount, backend.coverage.lines?.percent])).toEqual([
      ["apps/api", 1, 3, 2, 40],
      ["apps/legacy", 1, 2, 2, 20]
    ]);
    expect(scout!.coverage.lines).toEqual({ covered: 15, total: 20, percent: 75 });
    expect(scout!.backends[1]).toMatchObject({ directory: "apps/legacy", fileCount: 0, coverage: { lines: null } });

    const detail = database.getSlice(repositoryId, "INSPECT")!;
    expect(detail.endpoints.map((endpoint) => endpoint.backendDirectory)).toEqual(["apps/api", "apps/legacy"]);
    expect(detail.unmatchedCalls).toEqual(inspectSlice.unmatchedCalls);
    expect(database.getSlice(repositoryId, "missing")).toBeNull();

    expect(database.queryCoverageFiles(repositoryId, { sliceName: "inspect", metric: "lines" }).files.map((row) => row.path)).toEqual([
      "apps/legacy/routes/login.js",
      "apps/api/src/inspection.controller.ts",
      "apps/legacy/libs/users.js",
      "apps/api/src/shared.ts"
    ]);
  });

  it("seeds the trend from the current snapshot when slices are rebuilt", () => {
    snapshot("@acme/api", "run-1", [file("apps/api/src/shared.ts", 3, 4)]);
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice]);
    database.replaceSlices(repositoryId, "build-2", "abc124", [inspectSlice]);

    const history = database.listSliceHistory(repositoryId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ runId: "run-1", appName: "inspect", requestedRef: "snapshot", resolvedSha: "def456", tests: null });
    expect(history[0]!.coverage.lines).toEqual({ covered: 3, total: 4, percent: 75 });
  });

  it("records one point per slice per run from every backend that ran", () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice, scoutSlice]);
    const base = { repositoryId, requestedRef: "main", resolvedSha: "aaa111", useLocalWorkingTree: false, dirty: false };

    expect(
      database.recordSliceHistory({ ...base, runId: "run-other", filesByDirectory: new Map([["apps/inspect", [file("apps/inspect/src/main.tsx", 1, 1)]]]) })
    ).toBe(0);
    expect(
      database.recordSliceHistory({
        ...base,
        runId: "run-2",
        filesByDirectory: new Map([
          ["apps/api", [file("apps/api/src/inspection.controller.ts", 5, 10), file("apps/api/src/shared.ts", 10, 10)]],
          ["apps/legacy", [file("apps/legacy/routes/login.js", 0, 10)]]
        ])
      })
    ).toBe(2);

    const history = database.listSliceHistory(repositoryId);
    expect(history.map((entry) => [entry.runId, entry.appName, entry.coverage.lines?.covered, entry.coverage.lines?.total])).toEqual([
      ["run-2", "inspect", 15, 30],
      ["run-2", "scout", 10, 10]
    ]);
  });

  it("carries a backend that did not run forward from its snapshot", () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice]);
    snapshot("@acme/legacy", "run-1", legacyFiles);
    database.recordSliceHistory({
      repositoryId,
      runId: "run-3",
      requestedRef: "main",
      resolvedSha: "bbb222",
      useLocalWorkingTree: true,
      dirty: true,
      filesByDirectory: new Map([["apps/api", [file("apps/api/src/shared.ts", 1, 10)]]])
    });
    const point = database.listSliceHistory(repositoryId).find((entry) => entry.runId === "run-3")!;
    // apps/api from this run (1/10) plus apps/legacy from its snapshot (4/20).
    expect(point.coverage.lines).toEqual({ covered: 5, total: 30, percent: 16.7 });
    expect(point).toMatchObject({ useLocalWorkingTree: true, dirty: true });
  });

  it("exports every matching file with the slices that include it", () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice, scoutSlice]);
    snapshot("@acme/api", "run-1", apiFiles);
    const all = database.exportCoverageFiles(repositoryId, { metric: "lines" });
    expect(all.map((row) => [row.path, row.slices])).toEqual([
      ["apps/api/src/unrelated.ts", []],
      ["apps/api/src/inspection.controller.ts", ["inspect"]],
      ["apps/api/src/shared.ts", ["inspect", "scout"]],
      ["apps/api/src/scout.controller.ts", ["scout"]]
    ]);
    expect(database.exportCoverageFiles(repositoryId, { sliceName: "scout" }).map((row) => row.path)).toEqual([
      "apps/api/src/shared.ts",
      "apps/api/src/scout.controller.ts"
    ]);
  });

  it("sums coverage only from files that report each metric", () => {
    expect(sumCoverage([])).toEqual({ lines: null, statements: null, functions: null, branches: null });
    expect(
      sumCoverage([
        { lines: metric(1, 2), statements: null, functions: metric(0, 0), branches: null },
        { lines: metric(3, 6), statements: null, functions: metric(0, 0), branches: null }
      ])
    ).toEqual({ lines: { covered: 4, total: 8, percent: 50 }, statements: null, functions: { covered: 0, total: 0, percent: null }, branches: null });
  });

  it("removes slices, builds, and slice history with the repository", () => {
    database.setSliceConfig(repositoryId, config);
    database.createSliceBuild(repositoryId);
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice]);
    database.recordSliceHistory({
      repositoryId,
      runId: "run-1",
      requestedRef: "main",
      resolvedSha: null,
      useLocalWorkingTree: false,
      dirty: false,
      filesByDirectory: new Map([["apps/api", [file("apps/api/src/shared.ts", 1, 1)]]])
    });
    database.deleteRepository(repositoryId);
    const count = (table: string) =>
      (database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    expect([count("slices"), count("slice_files"), count("slice_builds"), count("slice_history")]).toEqual([0, 0, 0, 0]);
  });
});

describe("slice migration", () => {
  it("assigns existing slice files to their slice's backend", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-slices-migrate-"));
    const file = path.join(directory, "test.sqlite");
    try {
      // Build a database at migration 17 with one single-backend slice.
      const database = new QaBuddyDatabase(file);
      const repositoryId = database.createRepository(input).id;
      database.close();
      const raw = new BetterSqlite3(file);
      raw.exec("DELETE FROM schema_migrations WHERE version = 18");
      raw.exec("DROP TABLE slice_files; CREATE TABLE slice_files (slice_id TEXT NOT NULL REFERENCES slices(id) ON DELETE CASCADE, file_path TEXT NOT NULL, PRIMARY KEY (slice_id, file_path));");
      raw.exec("ALTER TABLE slices DROP COLUMN backends_json; ALTER TABLE slices DROP COLUMN unmatched_calls_json;");
      raw
        .prepare(`INSERT INTO slices(id, repository_id, build_id, name, frontend_directory, backend_directory, resolved_sha, built_at, endpoint_count, file_count, endpoints_json)
          VALUES ('s1', ?, 'b1', 'inspect', 'apps/inspect', 'apps/api', 'abc', '2026-11-04T00:00:00.000Z', 3, 1, '[]')`)
        .run(repositoryId);
      raw.exec("INSERT INTO slice_files(slice_id, file_path) VALUES ('s1', 'apps/api/src/a.ts')");
      raw.close();

      const migrated = new QaBuddyDatabase(file);
      const [slice] = migrated.listSlices(repositoryId);
      expect(slice!.backends).toEqual([
        expect.objectContaining({ directory: "apps/api", endpointCount: 3, fileCount: 1 })
      ]);
      expect(migrated.getSlice(repositoryId, "inspect")!.unmatchedCalls).toEqual([]);
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
