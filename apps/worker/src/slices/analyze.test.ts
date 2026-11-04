import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSlices } from "./analyze.js";
import { parseModule } from "./module-graph.js";
import { assignOperationIds } from "./nest-modules.js";
import { parseControllerEndpoints, swaggerPath, type NestEndpoint } from "./nest-endpoints.js";
import { CLIENT, OPTIONS, write, writeFixture } from "./test-fixture.js";

describe("slice analysis", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-slices-"));
    writeFixture(directory);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("traces a frontend's client calls through lazy routes and workspace libraries to backend files", async () => {
    const {
      slices: [inspect]
    } = await analyzeSlices(directory, [{ name: "inspect", frontendDirectory: "apps/inspect" }], OPTIONS);

    expect(inspect!.entryFiles).toEqual(["apps/inspect/src/main.tsx"]);
    expect(inspect!.endpoints.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path}`)).toEqual([
      "get /inspection-instance/filters",
      "get /inspection-instance/{id}",
      "get /work-order/{id}"
    ]);
    expect(inspect!.endpoints.every((endpoint) => !endpoint.ambiguous)).toBe(true);
    expect(inspect!.backendFiles).toEqual([
      "apps/api/src/common/dates.ts",
      "apps/api/src/inspection/inspection.controller.ts",
      "apps/api/src/inspection/inspection.service.ts",
      "apps/api/src/work-order/work-order.controller.ts"
    ]);
    // Values imported from the client that are not operations are reported, type imports are not.
    expect(inspect!.unmatchedClientNames).toEqual(["InspectionStatus"]);
  });

  it("resolves a duplicated method name to the endpoint that published it", async () => {
    const {
      slices: [scout]
    } = await analyzeSlices(directory, [{ name: "scout", frontendDirectory: "apps/scout" }], OPTIONS);

    expect(scout!.endpoints.map((endpoint) => `${endpoint.controller}.${endpoint.methodKey}`)).toEqual([
      "ScoutAssetsController.listScoutAssets",
      "ScoutAssetsController.getFilters"
    ]);
    expect(scout!.backendFiles).toEqual([
      "apps/api/src/scout/scout-assets.controller.ts",
      "apps/api/src/scout/scout.service.ts"
    ]);
  });

  it("skips frontends that cannot be traced and keeps the rest", async () => {
    write(directory, "apps/no-entry/package.json", JSON.stringify({ name: "@acme/no-entry" }));
    const result = await analyzeSlices(
      directory,
      [
        { name: "missing", frontendDirectory: "apps/missing" },
        { name: "no-entry", frontendDirectory: "apps/no-entry" },
        { name: "scout", frontendDirectory: "apps/scout" }
      ],
      OPTIONS
    );
    expect(result.slices.map((slice) => slice.name)).toEqual(["scout"]);
    expect(result.skipped).toEqual([
      { frontendDirectory: "apps/missing", reason: "not a pnpm workspace in this repository" },
      { frontendDirectory: "apps/no-entry", reason: "no entry point (index.html script or src/main) was found" }
    ]);
  });

  it("discovers apps that depend on the client package when no targets are given", async () => {
    write(
      directory,
      "apps/inspect/package.json",
      JSON.stringify({ name: "@acme/inspect", dependencies: { [CLIENT]: "workspace:*" } })
    );
    write(directory, "apps/scout/package.json", JSON.stringify({ name: "@acme/scout", devDependencies: { [CLIENT]: "workspace:*" } }));
    write(directory, "libs/ui/package.json", JSON.stringify({ name: "@acme/ui", dependencies: { [CLIENT]: "workspace:*" } }));
    const result = await analyzeSlices(directory, null, OPTIONS);
    expect(result.slices.map((slice) => [slice.name, slice.frontendDirectory])).toEqual([
      ["inspect", "apps/inspect"],
      ["scout", "apps/scout"]
    ]);
  });

  it("fails when the backend workspace does not exist", async () => {
    await expect(analyzeSlices(directory, null, { ...OPTIONS, backendDirectory: "apps/nope" })).rejects.toThrow(
      "apps/nope is not a pnpm workspace"
    );
  });
});

describe("module parsing", () => {
  it("ignores type-only imports and narrows namespace imports to the members used", () => {
    const parsed = parseModule(
      "file.ts",
      [
        `import type { A } from "client";`,
        `import { type B, c } from "client";`,
        `import * as ns from "other";`,
        `ns.useThing();`,
        `export { d } from "client";`
      ].join("\n")
    );
    expect(Array.from(parsed.importedNames.get("client") ?? [])).toEqual(["c", "d"]);
    expect(Array.from(parsed.importedNames.get("other") ?? [])).toEqual(["useThing"]);
  });
});

describe("operation ids", () => {
  const endpoint = (methodKey: string, routePath: string, explicitOperationId: string | null = null): NestEndpoint => ({
    file: "x.ts",
    controller: "X",
    methodKey,
    httpMethod: "get",
    path: routePath,
    explicitOperationId
  });

  it("converts Nest route syntax to swagger paths", () => {
    expect(swaggerPath("help", ":app/:id{/:layout}")).toBe("/help/{app}/{id}/{layout}");
    expect(swaggerPath("/", "")).toBe("/");
  });

  it("appends static path segments, the verb, then a counter to duplicates", () => {
    const first = endpoint("findAll", "/inspection");
    const second = endpoint("findAll", "/scout/assets/{id}");
    const third = endpoint("findAll", "/");
    const fourth = endpoint("other", "/elsewhere", "findAll");
    const ids = assignOperationIds([first, second, third, fourth]);
    expect([ids.get(first), ids.get(second), ids.get(third), ids.get(fourth)]).toEqual([
      "findAll",
      "findAllScoutAssets",
      "findAllGET",
      "findAllElsewhere"
    ]);
  });

  it("reads explicit operation ids, SSE routes, and skips excluded endpoints", () => {
    const endpoints = parseControllerEndpoints(
      "c.ts",
      [
        "@Controller(`tasks`)",
        "export class C {",
        "  @Sse(':id') stream() {}",
        "  @Post() @ApiOperation({ operationId: 'createTask' }) create() {}",
        "  @Get('hidden') @ApiExcludeEndpoint() hidden() {}",
        "}"
      ].join("\n")
    );
    expect(endpoints.map((item) => [item.httpMethod, item.path, item.explicitOperationId])).toEqual([
      ["get", "/tasks/{id}", null],
      ["post", "/tasks", "createTask"]
    ]);
  });
});
