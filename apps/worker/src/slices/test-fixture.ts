import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shared fixture for slice tests; not part of the worker's runtime code. */
export function write(root: string, file: string, contents: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

export const CLIENT = "@acme/api-client";
export const NEST_BACKEND = { directory: "apps/api", framework: "nestjs" as const, clientPackage: CLIENT };
export const EXPRESS_BACKEND = {
  directory: "apps/legacy",
  framework: "express" as const,
  entryFile: "app.js",
  baseUrlNames: ["VITE_LEGACY_HOST"]
};
export const OPTIONS = [NEST_BACKEND];

/**
 * A small monorepo: two frontends calling a NestJS backend through a generated
 * client, a shared UI library, path aliases, lazy routes, and two controllers
 * that both declare `getFilters` so one is published with a path suffix.
 */
export function writeFixture(root: string): void {
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'libs/*'\n");
  write(root, "libs/api-client/package.json", JSON.stringify({ name: CLIENT, main: "src/index.ts" }));
  write(root, "libs/ui/package.json", JSON.stringify({ name: "@acme/ui", exports: { ".": "./src/index.ts" } }));
  write(root, "libs/ui/src/index.ts", `export { WorkOrderBadge } from "./work-order-badge";\n`);
  write(
    root,
    "libs/ui/src/work-order-badge.tsx",
    `import { useGetWorkOrder } from "${CLIENT}";\nexport const WorkOrderBadge = () => useGetWorkOrder();\n`
  );

  // Inspect-like frontend.
  write(root, "apps/inspect/package.json", JSON.stringify({ name: "@acme/inspect" }));
  write(root, "apps/inspect/tsconfig.json", `{ "compilerOptions": { "paths": { "@/pages/*": ["./src/pages/*"] }, }, }`);
  write(root, "apps/inspect/index.html", `<script type="module" src="/src/main.tsx"></script>`);
  write(
    root,
    "apps/inspect/src/main.tsx",
    `import { WorkOrderBadge } from "@acme/ui";\nconst Page = () => import("@/pages/inspections");\nexport { WorkOrderBadge, Page };\n`
  );
  write(
    root,
    "apps/inspect/src/pages/inspections.tsx",
    [
      `import type { InspectionDto } from "${CLIENT}";`,
      `import { useGetFilters, getGetInspectionQueryKey, InspectionStatus } from "${CLIENT}";`,
      `export default () => [useGetFilters(), getGetInspectionQueryKey(), InspectionStatus];`
    ].join("\n")
  );
  // Unreachable from the entry point, so its endpoint must not count.
  write(root, "apps/inspect/src/pages/retired.tsx", `import { useListScoutAssets } from "${CLIENT}";\n`);
  write(root, "apps/inspect/src/pages/inspections.test.tsx", `import { useListScoutAssets } from "${CLIENT}";\n`);

  // Scout-like frontend calling the de-duplicated operation.
  write(root, "apps/scout/package.json", JSON.stringify({ name: "@acme/scout" }));
  write(
    root,
    "apps/scout/src/main.tsx",
    `import * as api from "${CLIENT}";\nexport default () => [api.useGetFiltersScoutAssetsFilters(), api.useListScoutAssets()];\n`
  );

  // NestJS backend.
  write(root, "apps/api/package.json", JSON.stringify({ name: "@acme/api" }));
  write(root, "apps/api/tsconfig.json", `{ "compilerOptions": { "paths": { "@app/*": ["./src/*"] } } }`);
  write(
    root,
    "apps/api/src/app.module.ts",
    [
      `import { Module } from "@nestjs/common";`,
      `import { InspectionModule } from "./inspection/inspection.module";`,
      `import { ScoutModule } from "./scout/scout.module";`,
      `import { WorkOrderModule } from "@app/work-order/work-order.module";`,
      `@Module({ imports: [ConfigModule.forRoot(), InspectionModule, forwardRef(() => ScoutModule), WorkOrderModule] })`,
      `export class AppModule {}`
    ].join("\n")
  );
  write(
    root,
    "apps/api/src/inspection/inspection.module.ts",
    `import { InspectionController } from "./inspection.controller";\n@Module({ controllers: [InspectionController] })\nexport class InspectionModule {}\n`
  );
  write(
    root,
    "apps/api/src/inspection/inspection.controller.ts",
    [
      `import { InspectionService } from "./inspection.service";`,
      `@Controller("inspection-instance")`,
      `export class InspectionController {`,
      `  constructor(private readonly service: InspectionService) {}`,
      `  @Get("filters") getFilters() {}`,
      "  @Get(`:id`) @ApiOperation({ operationId: `getInspection` }) findOne() {}",
      `}`
    ].join("\n")
  );
  write(
    root,
    "apps/api/src/inspection/inspection.service.ts",
    `import { formatDate } from "@app/common/dates";\nexport class InspectionService {}\n`
  );
  write(root, "apps/api/src/common/dates.ts", `export const formatDate = () => "";\n`);
  write(root, "apps/api/src/common/dates.spec.ts", `import { formatDate } from "./dates";\n`);
  write(
    root,
    "apps/api/src/scout/scout.module.ts",
    `import { ScoutAssetsController } from "./scout-assets.controller";\n@Module({ controllers: [ScoutAssetsController] })\nexport class ScoutModule {}\n`
  );
  write(
    root,
    "apps/api/src/scout/scout-assets.controller.ts",
    [
      `import { ScoutService } from "./scout.service";`,
      `@Controller("scout/assets")`,
      `export class ScoutAssetsController {`,
      `  @Get("filters") getFilters() {}`,
      `  @Get() listScoutAssets() {}`,
      `}`
    ].join("\n")
  );
  write(root, "apps/api/src/scout/scout.service.ts", `export class ScoutService {}\n`);
  write(
    root,
    "apps/api/src/work-order/work-order.module.ts",
    `import { WorkOrderController } from "./work-order.controller";\n@Module({ controllers: [WorkOrderController] })\nexport class WorkOrderModule {}\n`
  );
  write(
    root,
    "apps/api/src/work-order/work-order.controller.ts",
    `@Controller("work-order")\nexport class WorkOrderController {\n  @Get(":id") getWorkOrder() {}\n}\n`
  );

  writeExpressFixture(root);
}

/**
 * An Express backend in the shape of rpm-api: a route index that mounts every
 * sibling file, a nested router with a prefix, and models loaded from disk.
 * The inspect frontend calls it in several hand-written styles.
 */
export function writeExpressFixture(root: string): void {
  write(root, "apps/legacy/package.json", JSON.stringify({ name: "@acme/legacy", type: "commonjs" }));
  write(
    root,
    "apps/legacy/app.js",
    [
      "const express = require('express');",
      "const routes = require('./routes/index');",
      "const app = express();",
      "app.use(express.json());",
      "app.use('/', routes);",
      "module.exports = app;"
    ].join("\n")
  );
  write(
    root,
    "apps/legacy/routes/index.js",
    [
      "const fs = require('fs');",
      "const router = require('express').Router();",
      "router.get('/health-check', (req, res) => res.send('ok'));",
      "fs.readdirSync(__dirname).filter((f) => f !== 'index.js').forEach((f) => router.use(require(`./${f}`)));",
      "module.exports = router;"
    ].join("\n")
  );
  write(
    root,
    "apps/legacy/routes/users.js",
    [
      "const router = require('express').Router();",
      "const users = require('../libs/users');",
      "router.get('/users/:username', users.find);",
      "router.post('/login', users.login);",
      "router.get('/users/batch', users.batch);",
      "router.put('/users/:username/settings/:app?', users.save);",
      "module.exports = router;"
    ].join("\n")
  );
  write(
    root,
    "apps/legacy/routes/work-orders.js",
    [
      "const router = require('express').Router();",
      "const workOrderRoutes = require('./workOrderRoutes');",
      "router.use('/work-orders', workOrderRoutes);",
      "module.exports = router;"
    ].join("\n")
  );
  write(
    root,
    "apps/legacy/routes/workOrderRoutes/index.js",
    [
      "const express = require('express');",
      "const router = express.Router();",
      "const service = require('../../libs/work-orders');",
      "router.get('/count', service.count);",
      "router.delete('/:id', service.remove);",
      "module.exports = router;"
    ].join("\n")
  );
  write(root, "apps/legacy/routes/unmounted/orphan.js", "const router = require('express').Router();\nrouter.get('/orphan', () => {});\nmodule.exports = router;\n");
  write(root, "apps/legacy/libs/users.js", "const models = require('../models');\nmodule.exports = { find() {}, login() {}, batch() {}, save() {} };\n");
  write(root, "apps/legacy/libs/work-orders.js", "module.exports = { count() {}, remove() {} };\n");
  write(
    root,
    "apps/legacy/models/index.js",
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "const db = {};",
      "fs.readdirSync(__dirname).filter((f) => f !== 'index.js').forEach((f) => { db[f] = require(path.join(__dirname, f)); });",
      "module.exports = db;"
    ].join("\n")
  );
  write(root, "apps/legacy/models/user.js", "module.exports = {};\n");
  write(root, "apps/legacy/models/user.test.js", "require('./user');\n");

  // Hand-written requests from the inspect frontend, reached through its entry point.
  write(
    root,
    "apps/inspect/src/main.tsx",
    [
      `import { WorkOrderBadge } from "@acme/ui";`,
      `import "./legacy-calls";`,
      `const Page = () => import("@/pages/inspections");`,
      `export { WorkOrderBadge, Page };`
    ].join("\n")
  );
  write(
    root,
    "apps/inspect/src/legacy-client.ts",
    `import axios from "axios";\nexport const legacyClient = axios.create({ baseURL: import.meta.env.VITE_LEGACY_HOST });\n`
  );
  write(
    root,
    "apps/inspect/src/legacy-calls.ts",
    [
      `import axios from "axios";`,
      `import { legacyClient } from "./legacy-client";`,
      `const HOST = import.meta.env.VITE_LEGACY_HOST || "http://localhost:4900";`,
      `export const getUser = (name: string) => fetch(\`\${HOST}/users/\${name}?expand=true\`);`,
      `export const login = (body: unknown) => axios.post(import.meta.env.VITE_LEGACY_HOST + "/login", body);`,
      `export const saveSettings = (name: string) => {`,
      `  const url = \`\${import.meta.env.VITE_LEGACY_HOST}/users/\${name}/settings\`;`,
      `  return fetch(url, { method: "PUT" });`,
      `};`,
      `export const countWorkOrders = () => legacyClient.get("/work-orders/count");`,
      `export const relativeOnGlobalAxios = () => axios.get("/users/not-legacy");`,
      `export const goToHealth = () => { window.location.href = \`\${HOST}/health-check\`; };`,
      `export const mystery = (id: string) => fetch(\`\${HOST}/nowhere/\${id}\`, { method: "PATCH" });`
    ].join("\n")
  );
}
