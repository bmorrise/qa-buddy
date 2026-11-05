import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { apiEndpoints } from "./api-reference.js";
import { buildServer, registeredApiRoutes } from "./server.js";

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
      payload: { backends: [{ directory: "../outside", framework: "nestjs", clientPackage: "not a package" }] }
    });
    expect(invalid.statusCode).toBe(400);

    const expressWithoutNames = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/slices/config`,
      payload: { backends: [{ directory: "apps/legacy", framework: "express" }] }
    });
    expect(expressWithoutNames.statusCode).toBe(400);
    expect(expressWithoutNames.json().error).toContain("base URL names");

    const saved = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/slices/config`,
      payload: {
        backends: [
          { directory: "apps/api/", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "", entryFile: "ignored.js", baseUrlNames: ["VITE_API_V2"] },
          { directory: "apps/legacy", framework: "express", clientPackage: "@acme/ignored", baseUrlNames: ["VITE_LEGACY_HOST", "apiHost"] }
        ],
        frontendDirectories: ["apps/inspect"]
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toEqual({
      backends: [
        { directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: ["VITE_API_V2"] },
        { directory: "apps/legacy", framework: "express", clientPackage: null, rootModule: null, entryFile: "app.js", baseUrlNames: ["VITE_LEGACY_HOST", "apiHost"] }
      ],
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
        endpoints: [{ backendDirectory: "apps/api", httpMethod: "get", path: "/x", controller: "X", methodKey: "find", file: "apps/api/src/x.controller.ts", clientNames: ["useFind"] }],
        backends: [{ directory: "apps/api", endpointCount: 1, files: ["apps/api/src/x.controller.ts"] }]
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
      filesByDirectory: new Map([["apps/api", files]])
    });

    const detail = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices/inspect` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().slice).toMatchObject({ name: "inspect", measuredFileCount: 1, endpoints: [{ methodKey: "find" }] });
    expect((await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices/nope` })).statusCode).toBe(404);

    const history = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/slices/history` });
    expect(history.json().entries).toEqual([expect.objectContaining({ runId: "run-1", appName: "inspect" })]);

    const sliceFiles = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files?slice=inspect` });
    expect(sliceFiles.json().files.map((row: { path: string }) => row.path)).toEqual(["apps/api/src/x.controller.ts"]);

    database.setSliceConfig(repositoryId, {
      backends: [{ directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] }],
      frontendDirectories: []
    });
    const build = database.createSliceBuild(repositoryId);
    mkdirSync(path.join(directory, "logs"), { recursive: true });
    writeFileSync(path.join(directory, "logs", `slice-build-${build.id}.log`), "traced\n");
    const log = await app.inject({ method: "GET", url: `/api/slice-builds/${build.id}/log` });
    expect(log.body).toBe("traced\n");
    expect((await app.inject({ method: "GET", url: "/api/slice-builds/unknown/log" })).statusCode).toBe(404);
  });

  it("exports matching coverage files as CSV or JSON, unpaged", async () => {
    database.replaceSlices(repositoryId, "build-1", "abc123", [
      { name: "inspect", frontendDirectory: "apps/inspect", endpoints: [], backends: [{ directory: "apps/api", endpointCount: 0, files: ["apps/api/src/a,b.ts"] }] },
      { name: "scout", frontendDirectory: "apps/scout", endpoints: [], backends: [{ directory: "apps/api", endpointCount: 0, files: ["apps/api/src/a,b.ts", "apps/api/src/c;d.ts"] }] }
    ]);
    const metric = (covered: number, total: number) => ({ covered, total, percent: Math.round((covered / total) * 1000) / 10 });
    const files = Array.from({ length: 1_205 }, (_, index) => ({
      path: `apps/api/src/file-${String(index).padStart(4, "0")}.ts`,
      lines: metric(index % 10, 10),
      statements: null,
      functions: metric(1, 2),
      branches: metric(0, 4)
    }));
    files.push({ path: "apps/api/src/a,b.ts", lines: metric(1, 4), statements: null, functions: metric(0, 1), branches: metric(1, 2) });
    files.push({ path: "apps/api/src/c;d.ts", lines: metric(3, 4), statements: null, functions: metric(1, 1), branches: metric(2, 2) });
    database.replaceCoverageSnapshot(repositoryId, "@acme/api", {
      runId: "run-1",
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: null,
      summary: { lines: null, statements: null, functions: null, branches: null },
      files
    });

    const csv = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files/export?slice=inspect` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="platform-inspect-coverage-files-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.body.split("\r\n")).toEqual([
      "file,app,slices,lines_percent,lines_covered,lines_total,statements_percent,statements_covered,statements_total,functions_percent,functions_covered,functions_total,branches_percent,branches_covered,branches_total,uncovered_functions,uncovered_lines",
      '"apps/api/src/a,b.ts",@acme/api,"inspect, scout",25,1,4,,,,0,0,1,50,1,2,,',
      ""
    ]);

    // A file in several slices keeps them in one quoted cell, whatever separator the spreadsheet assumes.
    const shared = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files/export?slice=scout` });
    expect(shared.body.split("\r\n").slice(1, 3)).toEqual([
      '"apps/api/src/a,b.ts",@acme/api,"inspect, scout",25,1,4,,,,0,0,1,50,1,2,,',
      '"apps/api/src/c;d.ts",@acme/api,scout,75,3,4,,,,100,1,1,100,2,2,,'
    ]);

    const json = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files/export?format=json&metric=lines&maxPercent=0` });
    const body = json.json();
    expect(body.filters).toMatchObject({ metric: "lines", maxPercent: 0 });
    expect(body.total).toBe(121);
    expect(body.files[0]).toMatchObject({ path: "apps/api/src/file-0000.ts", slices: [] });

    const all = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files/export?format=json` });
    expect(all.json().total).toBe(1_207);
    expect((await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files/export?format=xml` })).statusCode).toBe(400);
  });

  it("publishes an API reference that lists exactly the registered routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api" });
    expect(response.json().endpoints).toEqual(apiEndpoints);
    const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
    expect(apiEndpoints.map(key).sort()).toEqual(registeredApiRoutes(app).map(key).sort());
  });

  it("serves one file's gaps and adds them to the CSV", async () => {
    const metric = { covered: 1, total: 4, percent: 25 };
    database.replaceCoverageSnapshot(repositoryId, "@acme/api", {
      runId: "run-1",
      resolvedSha: "def456",
      coverageFormat: "istanbul-summary-json",
      coveragePath: null,
      summary: { lines: metric, statements: metric, functions: metric, branches: metric },
      files: [
        {
          path: "apps/api/src/users.ts",
          lines: metric,
          statements: metric,
          functions: metric,
          branches: metric,
          details: {
            uncoveredLines: [[4, 6], [9, 9]],
            uncoveredFunctions: [{ name: "remove", line: 4 }, { name: "rename", line: 9 }],
            uncoveredBranches: [{ line: 5, type: "if", uncovered: 1, total: 2 }]
          }
        }
      ]
    });

    const found = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/file?path=apps/api/src/users.ts` });
    expect(found.json().file).toMatchObject({ appName: "@acme/api", details: { uncoveredFunctions: [{ name: "remove" }, { name: "rename" }] } });
    expect((await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/file?path=nope.ts` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/file` })).statusCode).toBe(400);

    const csv = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/coverage/files/export` });
    const [header, row] = csv.body.split("\r\n");
    expect(header!.endsWith(",uncovered_functions,uncovered_lines")).toBe(true);
    expect(row!.endsWith(',"remove (line 4), rename (line 9)","4-6, 9"')).toBe(true);
  });
});
