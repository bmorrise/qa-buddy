import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findEmberDataRequests, pluralize } from "./ember-data.js";
import { listCodeFiles, readSourceText, stripTemplates } from "./module-graph.js";
import { write } from "./test-fixture.js";

describe("Ember Data requests", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-ember-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const requests = () => {
    const app = path.join(directory, "app");
    return findEmberDataRequests(app, listCodeFiles(app), readSourceText, (file) => path.relative(directory, file), ["apiHost"]).map(
      (request) => `${request.baseName} ${request.call.method?.toUpperCase()} ${request.call.path}${request.inferred ? " (inferred)" : ""}`
    );
  };

  it("pluralizes model names the way Ember does for common words", () => {
    expect(["company", "alert", "work-order", "address", "box", "key"].map(pluralize)).toEqual([
      "companies",
      "alerts",
      "work-orders",
      "addresses",
      "boxes",
      "keys"
    ]);
  });

  it("applies namespaces, REST adapter conventions, and skips adapters without a known host", () => {
    write(directory, "app/models/contact.ts", "export default class Contact {}\n");
    write(directory, "app/models/work-order.ts", "export default class WorkOrder {}\n");
    write(directory, "app/models/tile.ts", "export default class Tile {}\n");
    write(
      directory,
      "app/adapters/contact.ts",
      "import JSONAPIAdapter from '@ember-data/adapter/json-api';\nexport default class extends JSONAPIAdapter {\n  namespace = 'v2';\n  host = env.apiHost;\n}\n"
    );
    write(
      directory,
      "app/adapters/work-order.ts",
      "import RESTAdapter from '@ember-data/adapter/rest';\nexport default class extends RESTAdapter {\n  get host() {\n    return config.apiHost;\n  }\n}\n"
    );
    write(directory, "app/adapters/tile.ts", "import JSONAPIAdapter from '@ember-data/adapter/json-api';\nexport default class extends JSONAPIAdapter {\n  host = 'https://tiles.example.com';\n}\n");
    write(
      directory,
      "app/routes/index.ts",
      "export default class {\n  model() {\n    this.store.findAll('contact');\n    this.store.findRecord('work-order', 1);\n    this.store.findAll('tile');\n    this.store.peekRecord('nonsense', 1);\n  }\n}\n"
    );
    expect(requests()).toEqual([
      "apiHost GET /v2/contacts",
      "apiHost GET /workOrders/{}",
      "apiHost PATCH /v2/contacts/{} (inferred)",
      "apiHost DELETE /v2/contacts/{} (inferred)",
      "apiHost PUT /workOrders/{} (inferred)",
      "apiHost DELETE /workOrders/{} (inferred)"
    ]);
  });
});

describe("template stripping", () => {
  it("blanks <template> blocks and keeps line numbers", () => {
    const text = "const a = 1;\n<template>\n  <p>{{this.x}}</p>\n</template>\nconst b = 2;\n";
    const stripped = stripTemplates(text);
    expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
    expect(stripped).not.toContain("<p>");
    expect(stripped.split("\n")[4]).toBe("const b = 2;");
  });
});
