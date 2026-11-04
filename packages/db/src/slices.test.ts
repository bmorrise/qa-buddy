import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  backendDirectory: "apps/api",
  clientPackage: "@acme/api-client",
  rootModule: "src/app.module.ts",
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

const inspectSlice: SliceInput = {
  name: "inspect",
  frontendDirectory: "apps/inspect",
  backendDirectory: "apps/api",
  endpoints: [
    { httpMethod: "get", path: "/inspection", controller: "InspectionController", methodKey: "findAll", file: "apps/api/src/inspection.controller.ts", clientNames: ["useFindAll"] }
  ],
  files: ["apps/api/src/inspection.controller.ts", "apps/api/src/shared.ts", "apps/api/src/types.ts"]
};

const scoutSlice: SliceInput = {
  name: "scout",
  frontendDirectory: "apps/scout",
  backendDirectory: "apps/api",
  endpoints: [],
  files: ["apps/api/src/scout.controller.ts", "apps/api/src/shared.ts"]
};

describe("slices", () => {
  let directory: string;
  let database: QaBuddyDatabase;
  let repositoryId: string;

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
    // Finished, so another build may start.
    expect(database.createSliceBuild(repositoryId, "develop").requestedRef).toBe("develop");
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

  it("measures slices against the backend snapshot, counting shared files in each slice", () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice, scoutSlice]);
    const unmeasured = database.listSlices(repositoryId);
    expect(unmeasured.map((slice) => [slice.name, slice.fileCount, slice.measuredFileCount])).toEqual([
      ["inspect", 3, 0],
      ["scout", 2, 0]
    ]);
    expect(unmeasured[0]!.coverage.lines).toBeNull();
    expect(database.listSliceHistory(repositoryId)).toEqual([]);

    database.replaceCoverageSnapshot(repositoryId, "@acme/api", {
      runId: "run-1",
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "apps/api/coverage/coverage-summary.json",
      summary: sumCoverage([]),
      files: [
        file("apps/api/src/inspection.controller.ts", 2, 10),
        file("apps/api/src/shared.ts", 6, 10),
        file("apps/api/src/scout.controller.ts", 9, 10),
        file("apps/api/src/unrelated.ts", 0, 50)
      ]
    });
    // Another app's report listing a path outside the backend must not count.
    database.replaceCoverageSnapshot(repositoryId, "@acme/inspect", {
      runId: "run-1",
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "apps/inspect/coverage/coverage-summary.json",
      summary: sumCoverage([]),
      files: [file("apps/inspect/src/main.tsx", 1, 1)]
    });

    const [inspect, scout] = database.listSlices(repositoryId);
    expect(inspect).toMatchObject({ measuredFileCount: 2, coverageSha: "def456", resolvedSha: "abc123", endpointCount: 1 });
    expect(inspect!.coverage.lines).toEqual({ covered: 8, total: 20, percent: 40 });
    expect(scout!.coverage.lines).toEqual({ covered: 15, total: 20, percent: 75 });
    expect(database.getSlice(repositoryId, "INSPECT")?.endpoints[0]?.methodKey).toBe("findAll");
    expect(database.getSlice(repositoryId, "missing")).toBeNull();

    const sliceFiles = database.queryCoverageFiles(repositoryId, { sliceName: "inspect", metric: "lines" });
    expect(sliceFiles.files.map((row) => row.path)).toEqual([
      "apps/api/src/inspection.controller.ts",
      "apps/api/src/shared.ts"
    ]);
  });

  it("seeds the trend from the current snapshot when slices are rebuilt", () => {
    database.replaceCoverageSnapshot(repositoryId, "@acme/api", {
      runId: "run-1",
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: null,
      summary: sumCoverage([]),
      files: [file("apps/api/src/shared.ts", 3, 4)]
    });
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice]);
    database.replaceSlices(repositoryId, "build-2", "abc124", [inspectSlice]);

    const history = database.listSliceHistory(repositoryId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      runId: "run-1",
      appName: "inspect",
      requestedRef: "snapshot",
      resolvedSha: "def456",
      tests: null
    });
    expect(history[0]!.coverage.lines).toEqual({ covered: 3, total: 4, percent: 75 });
  });

  it("records each run's coverage for the slices measured against that app", () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [inspectSlice, scoutSlice]);
    const base = {
      repositoryId,
      requestedRef: "main",
      resolvedSha: "aaa111",
      useLocalWorkingTree: false,
      dirty: false
    };

    expect(
      database.recordSliceHistory({ ...base, runId: "run-other", workingDirectory: "apps/inspect", files: [file("apps/inspect/src/main.tsx", 1, 1)] })
    ).toBe(0);
    expect(
      database.recordSliceHistory({
        ...base,
        runId: "run-2",
        workingDirectory: "apps/api",
        files: [file("apps/api/src/inspection.controller.ts", 5, 10), file("apps/api/src/shared.ts", 10, 10)]
      })
    ).toBe(2);
    // A re-recorded run replaces its own point.
    database.recordSliceHistory({
      ...base,
      runId: "run-2",
      useLocalWorkingTree: true,
      dirty: true,
      workingDirectory: "apps/api",
      files: [file("apps/api/src/shared.ts", 1, 10)]
    });

    const history = database.listSliceHistory(repositoryId);
    expect(history.map((entry) => [entry.runId, entry.appName, entry.coverage.lines?.percent, entry.useLocalWorkingTree])).toEqual([
      ["run-2", "inspect", 10, true],
      ["run-2", "scout", 10, true]
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
      workingDirectory: "apps/api",
      files: [file("apps/api/src/shared.ts", 1, 1)]
    });
    database.deleteRepository(repositoryId);
    const count = (table: string) =>
      (database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    expect([count("slices"), count("slice_files"), count("slice_builds"), count("slice_history")]).toEqual([0, 0, 0, 0]);
  });
});
