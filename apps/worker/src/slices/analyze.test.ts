import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSlices } from "./analyze.js";
import { parseModule } from "./module-graph.js";
import { assignOperationIds } from "./nest-modules.js";
import { parseControllerEndpoints, swaggerPath, type NestEndpoint } from "./nest-endpoints.js";
import {
  CLIENT,
  EMBER_LEGACY_BACKEND,
  EXPRESS_BACKEND,
  NEST_BACKEND,
  OPTIONS,
  RENDER_BACKEND,
  write,
  writeEmberFixture,
  writeFixture
} from "./test-fixture.js";

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

  it("adds hand-written requests to an Express backend as a second backend of the slice", async () => {
    const {
      slices: [inspect]
    } = await analyzeSlices(directory, [{ name: "inspect", frontendDirectory: "apps/inspect" }], [NEST_BACKEND, EXPRESS_BACKEND]);

    const legacy = inspect!.endpoints.filter((endpoint) => endpoint.backendDirectory === "apps/legacy");
    expect(legacy.map((endpoint) => [endpoint.httpMethod, endpoint.path, endpoint.clientNames])).toEqual([
      ["get", "/health-check", ["apps/inspect/src/legacy-calls.ts:12"]],
      ["post", "/login", ["apps/inspect/src/legacy-calls.ts:5"]],
      ["get", "/users/{username}", ["apps/inspect/src/legacy-calls.ts:4"]],
      ["put", "/users/{username}/settings/{app?}", ["apps/inspect/src/legacy-calls.ts:8"]],
      ["get", "/work-orders/count", ["apps/inspect/src/legacy-calls.ts:10"]]
    ]);
    expect(inspect!.backends.map((backend) => [backend.directory, backend.endpointCount, backend.files])).toEqual([
      ["apps/api", 3, [
        "apps/api/src/common/dates.ts",
        "apps/api/src/inspection/inspection.controller.ts",
        "apps/api/src/inspection/inspection.service.ts",
        "apps/api/src/work-order/work-order.controller.ts"
      ]],
      ["apps/legacy", 5, [
        // The route index serves /health-check, but its sibling mounts are not dependencies.
        "apps/legacy/libs/users.js",
        "apps/legacy/libs/work-orders.js",
        "apps/legacy/models/index.js",
        "apps/legacy/models/user.js",
        "apps/legacy/routes/index.js",
        "apps/legacy/routes/users.js",
        "apps/legacy/routes/workOrderRoutes/index.js"
      ]]
    ]);
    expect(inspect!.backendFiles).toHaveLength(11);
    expect(inspect!.unmatchedCalls).toEqual([
      { backendDirectory: "apps/legacy", site: "apps/inspect/src/legacy-calls.ts:13", method: "patch", path: "/nowhere/{}" }
    ]);
  });

  it("traces an Ember app through convention-loaded files, Ember Data adapters, and an injected fetch service", async () => {
    writeEmberFixture(directory);
    const {
      slices: [viewer]
    } = await analyzeSlices(directory, [{ name: "viewer", frontendDirectory: "apps/viewer" }], [EMBER_LEGACY_BACKEND, RENDER_BACKEND]);

    expect(viewer!.endpoints.map((endpoint) => [endpoint.backendDirectory, endpoint.httpMethod, endpoint.path, endpoint.clientNames])).toEqual([
      ["apps/legacy", "get", "/assets/{guid}", ["apps/viewer/app/routes/company.ts:10"]],
      // record.save() does not name its model, so saving any model the app reaches is assumed.
      ["apps/legacy", "patch", "/companies/{id}", ["apps/viewer/app/models/company.ts (save or delete, inferred)"]],
      ["apps/legacy", "get", "/companies/{slug}", ["apps/viewer/app/routes/company.ts:7"]],
      ["apps/legacy", "post", "/favorites", ["apps/viewer/app/components/favorite-button.gts:6"]],
      ["apps/legacy", "get", "/notifications", ["apps/viewer/app/routes/company.ts:9"]],
      [
        "apps/legacy",
        "get",
        "/properties/{company}/{property}",
        ["apps/viewer/app/models/company.ts (async relationship to property)", "apps/viewer/app/routes/company.ts:8"]
      ],
      ["apps/render", "post", "/", ["apps/viewer/app/components/favorite-button.gts:7"]],
      ["apps/render", "get", "/logs", ["apps/viewer/app/routes/company.ts:11"]]
    ]);
    // Seen requests that reach no route are reported; inferred ones (DELETE /companies/{}) are not. Mirage is ignored.
    expect(viewer!.unmatchedCalls).toEqual([
      { backendDirectory: "apps/legacy", site: "apps/viewer/app/components/favorite-button.gts:11", method: "delete", path: "/missing/{}" }
    ]);
    expect(viewer!.backends.map((backend) => [backend.directory, backend.files])).toEqual([
      ["apps/legacy", ["apps/legacy/libs/companies.js", "apps/legacy/routes/companies.js"]],
      ["apps/render", ["apps/render/app.js", "apps/render/libs/render.js"]]
    ]);
  });

  it("fails when the backend workspace does not exist", async () => {
    await expect(analyzeSlices(directory, null, [{ ...OPTIONS[0]!, directory: "apps/nope" }])).rejects.toThrow(
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
