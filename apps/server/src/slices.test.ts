import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { buildServer } from "./server.js";

const repositoryInput = {
  name: "Platform",
  githubUrl: "https://github.com/example/platform",
  defaultRef: "main",
  runnerImage: "node:22-bookworm",
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: true,
  apps: []
};

describe("slice API", () => {
  let directory: string;
  let database: QaBuddyDatabase;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let repositoryId: string;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-slices-api-"));
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
    app = await buildServer({ database, dataDirectory: directory });
    const created = await app.inject({ method: "POST", url: "/api/repositories", payload: repositoryInput });
    repositoryId = created.json().repository.id as string;
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("saves a validated recipe and queues one build at a time", async () => {
    const empty = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices` });
    expect(empty.json()).toEqual({ config: null, builds: [], slices: [] });

    const early = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/slices/builds`, payload: {} });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toContain("Set up slices");

    const invalid = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/slices/config`,
      payload: { backendDirectory: "../outside", clientPackage: "not a package" }
    });
    expect(invalid.statusCode).toBe(400);

    const saved = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/slices/config`,
      payload: { backendDirectory: "apps/api/", clientPackage: "@acme/api-client", rootModule: "", frontendDirectories: ["apps/inspect"] }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toEqual({
      backendDirectory: "apps/api",
      clientPackage: "@acme/api-client",
      rootModule: "src/app.module.ts",
      frontendDirectories: ["apps/inspect"]
    });

    const local = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/slices/builds`,
      payload: { useLocalWorkingTree: true }
    });
    expect(local.statusCode).toBe(400);

    const queued = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/slices/builds`, payload: { ref: "develop" } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().build).toMatchObject({ status: "queued", requestedRef: "develop" });

    const duplicate = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/slices/builds`, payload: {} });
    expect(duplicate.statusCode).toBe(409);

    const overview = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices` });
    expect(overview.json().builds).toHaveLength(1);
  });

  it("serves slices, their history, their files, and build logs", async () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [
      {
        name: "inspect",
        frontendDirectory: "apps/inspect",
        backendDirectory: "apps/api",
        endpoints: [{ httpMethod: "get", path: "/x", controller: "X", methodKey: "find", file: "apps/api/src/x.controller.ts", clientNames: ["useFind"] }],
        files: ["apps/api/src/x.controller.ts"]
      }
    ]);
    const metric = { covered: 1, total: 4, percent: 25 };
    const files = [{ path: "apps/api/src/x.controller.ts", lines: metric, statements: metric, functions: metric, branches: metric }];
    database.replaceCoverageSnapshot(repositoryId, "@acme/api", {
      runId: "run-1",
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: null,
      summary: { lines: metric, statements: metric, functions: metric, branches: metric },
      files: [...files, { ...files[0]!, path: "apps/api/src/other.ts" }]
    });
    database.recordSliceHistory({
      repositoryId,
      runId: "run-1",
      requestedRef: "main",
      resolvedSha: "def456",
      useLocalWorkingTree: false,
      dirty: false,
      workingDirectory: "apps/api",
      files
    });

    const detail = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices/inspect` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().slice).toMatchObject({ name: "inspect", measuredFileCount: 1, endpoints: [{ methodKey: "find" }] });
    expect((await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices/nope` })).statusCode).toBe(404);

    const history = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices/history` });
    expect(history.json().entries).toEqual([expect.objectContaining({ runId: "run-1", appName: "inspect" })]);

    const sliceFiles = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files?slice=inspect` });
    expect(sliceFiles.json().files.map((row: { path: string }) => row.path)).toEqual(["apps/api/src/x.controller.ts"]);

    database.setSliceConfig(repositoryId, { backendDirectory: "apps/api", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", frontendDirectories: [] });
    const build = database.createSliceBuild(repositoryId);
    mkdirSync(path.join(directory, "logs"), { recursive: true });
    writeFileSync(path.join(directory, "logs", `slice-build-${build.id}.log`), "traced\n");
    const log = await app.inject({ method: "GET", url: `/api/slice-builds/${build.id}/log` });
    expect(log.body).toBe("traced\n");
    expect((await app.inject({ method: "GET", url: "/api/slice-builds/unknown/log" })).statusCode).toBe(404);
  });
});
