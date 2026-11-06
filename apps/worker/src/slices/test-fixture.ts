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

export const EMBER_LEGACY_BACKEND = { ...EXPRESS_BACKEND, baseUrlNames: ["VITE_LEGACY_HOST", "legacyHost"] };
export const RENDER_BACKEND = { directory: "apps/render", framework: "express" as const, entryFile: "app.js", baseUrlNames: ["renderHost"] };

/**
 * An Ember app in the shape of rpm-viewer, calling the legacy Express backend
 * and a second Express backend through Ember Data adapters, an injected fetch
 * service, and spelled-out URLs, from `.ts` and `.gts` files that nothing imports.
 */
export function writeEmberFixture(root: string): void {
  writeExpressFixture(root);
  write(
    root,
    "apps/legacy/routes/companies.js",
    [
      "const router = require('express').Router();",
      "const companies = require('../libs/companies');",
      "router.get('/companies/:slug', companies.find);",
      "router.patch('/companies/:id', companies.update);",
      "router.get('/properties/:company/:property', companies.property);",
      "router.get('/notifications', companies.notifications);",
      "router.get('/assets/:guid', companies.asset);",
      "router.post('/favorites', companies.favorite);",
      "module.exports = router;"
    ].join("\n")
  );
  write(root, "apps/legacy/libs/companies.js", "module.exports = { find() {}, update() {}, property() {}, notifications() {}, asset() {}, favorite() {} };\n");
  write(root, "apps/render/package.json", JSON.stringify({ name: "@acme/render" }));
  write(
    root,
    "apps/render/app.js",
    [
      "const express = require('express');",
      "const render = require('./libs/render');",
      "const app = express();",
      "app.post('/', render.svg);",
      "app.get('/logs', render.logs);",
      "app.get('/health-check', () => {});",
      "module.exports = app;"
    ].join("\n")
  );
  write(root, "apps/render/libs/render.js", "module.exports = { svg() {}, logs() {} };\n");

  const app = "apps/viewer/app";
  write(root, "apps/viewer/package.json", JSON.stringify({ name: "viewer", devDependencies: { "ember-source": "~6.0.0" } }));
  write(root, "apps/viewer/index.html", `<script type="module">\n  import Application from './app/app';\n  Application.create({});\n</script>`);
  write(
    root,
    `${app}/app.ts`,
    `import Application from '@ember/application';\nimport compatModules from '@embroider/virtual/compat-modules';\nexport default class App extends Application {}\n`
  );
  write(root, `${app}/config/environment.js`, `export default { legacyHost: 'http://localhost:4900/', renderHost: 'http://localhost:4500' };\n`);

  // Models and adapters.
  write(root, `${app}/models/company.ts`, `import Model, { hasMany } from '@ember-data/model';\nexport default class Company extends Model {\n  @hasMany('property', { async: true, inverse: null }) properties;\n}\n`);
  write(root, `${app}/models/property.ts`, `import Model, { belongsTo } from '@ember-data/model';\nexport default class Property extends Model {\n  @belongsTo('company', { async: false, inverse: null }) company;\n}\n`);
  write(root, `${app}/models/alert.ts`, `import Model from '@ember-data/model';\nexport default class Alert extends Model {}\n`);
  write(root, `${app}/models/asset.ts`, `import Model from '@ember-data/model';\nexport default class Asset extends Model {}\n`);
  write(root, `${app}/models/log.ts`, `import Model from '@ember-data/model';\nexport default class Log extends Model {}\n`);
  write(
    root,
    `${app}/adapters/application.ts`,
    [
      "import JSONAPIAdapter from '@ember-data/adapter/json-api';",
      "import env from 'viewer/config/environment';",
      "export default class ApplicationAdapter extends JSONAPIAdapter {",
      "  constructor() {",
      "    super(...arguments);",
      "    this.host = env.legacyHost.replace(/\\/$/, '');",
      "  }",
      "  findRecord(store, type, id, snapshot) {",
      "    if (snapshot.modelName === 'property') {",
      "      let url = this.buildURL(type.modelName, snapshot.adapterOptions.companySlug, snapshot, 'findRecord');",
      "      url = `${url}/${id}`;",
      "      return this.ajax(url, 'GET');",
      "    }",
      "    return super.findRecord(...arguments);",
      "  }",
      "}"
    ].join("\n")
  );
  write(root, `${app}/adapters/alert.ts`, `import ApplicationAdapter from './application';\nexport default class AlertAdapter extends ApplicationAdapter {\n  pathForType() {\n    return 'notifications';\n  }\n}\n`);
  write(
    root,
    `${app}/adapters/asset.ts`,
    [
      "import ApplicationAdapter from './application';",
      "export default class AssetAdapter extends ApplicationAdapter {",
      "  queryRecord(store, type, params) {",
      "    const url = this.buildURL(type.modelName, params.id, params, 'findRecord');",
      "    return this.ajax(`${url}/${params.guid}?company=${params.company}`, 'GET');",
      "  }",
      "}"
    ].join("\n")
  );
  write(
    root,
    `${app}/adapters/log.ts`,
    `import ApplicationAdapter from './application';\nimport env from 'viewer/config/environment';\nexport default class LogAdapter extends ApplicationAdapter {\n  constructor() {\n    super(...arguments);\n    this.host = env.renderHost;\n  }\n}\n`
  );

  // A fetch service whose helpers put the legacy base in front of relative paths.
  write(
    root,
    `${app}/services/fetch.ts`,
    [
      "import Service from '@ember/service';",
      "import env from 'viewer/config/environment';",
      "export default class FetchService extends Service {",
      "  post(url, options) { return this.request(url, { ...options, method: 'POST' }); }",
      "  render(url, options) { return this.request(`${env.renderHost}${url}`, options); }",
      "  async request(_url, options) {",
      "    const url = _url.includes('://') ? _url : `${env.legacyHost}${_url}`;",
      "    return globalThis.fetch(url, options);",
      "  }",
      "}"
    ].join("\n")
  );

  // Store calls, builders, and requests, from files reached only by convention.
  write(
    root,
    `${app}/routes/company.ts`,
    [
      "import Route from '@ember/routing/route';",
      "import { service } from '@ember/service';",
      "import { query, queryRecord } from '@warp-drive/legacy/compat/builders';",
      "export default class CompanyRoute extends Route {",
      "  @service declare store;",
      "  async model({ slug }) {",
      "    const company = await this.store.findRecord('company', slug);",
      "    await this.store.findRecord('property', 'hq', { adapterOptions: { companySlug: slug } });",
      "    await this.store.request(query('alert', { company: slug }));",
      "    await this.store.request(queryRecord('asset', { guid: 'abc', company: slug }));",
      "    await this.store.request(query('log', {}));",
      "    return company;",
      "  }",
      "}"
    ].join("\n")
  );
  write(
    root,
    `${app}/components/favorite-button.gts`,
    [
      "import Component from '@glimmer/component';",
      "import { service } from '@ember/service';",
      "import env from 'viewer/config/environment';",
      "export default class FavoriteButton extends Component {",
      "  @service declare fetch;",
      "  save = () => this.fetch.post('favorites', { data: {} });",
      "  render = () => this.fetch.raw(env.renderHost, { method: 'POST' });",
      "  <template>",
      "    <button {{on 'click' this.save}}>Favorite {{@name}}</button>",
      "  </template>",
      "  ping = () => fetch(`${env.legacyHost}missing/${this.args.id}`, { method: 'DELETE' });",
      "}"
    ].join("\n")
  );
  // Mock-server code is not application code.
  write(root, `${app}/mirage/config.js`, "import env from 'viewer/config/environment';\nexport default () => fetch(`${env.legacyHost}mirage-only`);\n");
}
