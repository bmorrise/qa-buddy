import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExpressEndpoints, joinExpressPath, parseExpressFile } from "./express-routes.js";
import { ModuleResolver } from "./module-graph.js";
import { writeFixture } from "./test-fixture.js";
import { listWorkspacePackages } from "./workspaces.js";

describe("Express route index", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-express-"));
    writeFixture(directory);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("follows app and router mounts, including sibling files loaded from disk", async () => {
    const resolver = new ModuleResolver(directory, await listWorkspacePackages(directory));
    const routes = findExpressEndpoints(directory, "apps/legacy", "app.js", resolver);
    expect(routes.map((route) => `${route.httpMethod} ${route.path} ${route.file}`).sort()).toEqual([
      "delete /work-orders/{id} apps/legacy/routes/workOrderRoutes/index.js",
      "get /health-check apps/legacy/routes/index.js",
      "get /users/batch apps/legacy/routes/users.js",
      "get /users/{username} apps/legacy/routes/users.js",
      "get /work-orders/count apps/legacy/routes/workOrderRoutes/index.js",
      "post /login apps/legacy/routes/users.js",
      "put /users/{username}/settings/{app?} apps/legacy/routes/users.js"
    ]);
  });

  it("reads route chains, array paths, local sub-routers, and ESM exports", () => {
    const parsed = parseExpressFile(
      "routes.ts",
      [
        "import express from 'express';",
        "const router = express.Router();",
        "const nested = express.Router();",
        "router.route('/items').get(list).post(create);",
        "router.get(['/a', '/b'], handler);",
        "nested.get('/deep', handler);",
        "router.use('/nested', nested);",
        "router.use('/files*', (req, res, next) => next());",
        "export default router;"
      ].join("\n")
    );
    expect(parsed.exported).toBe("router");
    expect(parsed.endpoints).toEqual([
      { router: "router", method: "post", path: "/items" },
      { router: "router", method: "get", path: "/items" },
      { router: "router", method: "get", path: "/a" },
      { router: "router", method: "get", path: "/b" },
      { router: "nested", method: "get", path: "/deep" }
    ]);
    expect(parsed.mounts).toEqual([{ router: "router", prefix: "/nested", target: { kind: "local", name: "nested" } }]);
  });

  it("joins mount prefixes into swagger-style paths", () => {
    expect(joinExpressPath("/", "/work-orders", "/:workOrderId/files", "/")).toBe("/work-orders/{workOrderId}/files");
    expect(joinExpressPath("", "/saml/login/callback/:identityProvider?")).toBe("/saml/login/callback/{identityProvider?}");
  });
});
