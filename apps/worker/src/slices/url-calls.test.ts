import { describe, expect, it } from "vitest";
import type { NestEndpoint } from "./nest-endpoints.js";
import { matchCall, NO_CLIENT, UrlCallScanner } from "./url-calls.js";

const route = (httpMethod: string, routePath: string): NestEndpoint => ({
  file: "routes.js",
  controller: "routes",
  methodKey: "",
  httpMethod,
  path: routePath,
  explicitOperationId: null
});

describe("URL call scanning", () => {
  const scanner = new UrlCallScanner(["VITE_API_HOST", "apiHost"]);
  const scan = (text: string, importsClient = false) =>
    scanner.scan("file.ts", text, { ...NO_CLIENT, importsClient }).map((call) => [call.method, call.path]);

  it("reads base URL templates, concatenation, aliases, and fetch options", () => {
    expect(
      scan(
        [
          "const base = import.meta.env.VITE_API_HOST;",
          "fetch(`${base}/companies/${name}?slugged=true`);",
          "axios.delete(import.meta.env.VITE_API_HOST + `/files/${id}`);",
          "fetch(`${import.meta.env.VITE_API_V2 || import.meta.env.VITE_API_HOST}/auth/login-flow`, { method: 'POST' });",
          "const settings = ({ apiHost }) => fetch(`${apiHost}/role`);"
        ].join("\n")
      )
    ).toEqual([
      ["get", "/companies/{}"],
      ["delete", "/files/{}"],
      ["post", "/auth/login-flow"],
      ["get", "/role"]
    ]);
  });

  it("follows URLs stored in variables and records other uses with an unknown method", () => {
    expect(
      scan(
        [
          "let url = `${import.meta.env.VITE_API_HOST}/users/${id}`;",
          "await axios.put(url, body);",
          "window.location.href = `${import.meta.env.VITE_API_HOST}/saml/login/${slug}`;",
          "const orphan = `${import.meta.env.VITE_API_HOST}/reports`;"
        ].join("\n")
      )
    ).toEqual([
      ["put", "/users/{}"],
      [null, "/saml/login/{}"],
      [null, "/reports"]
    ]);
  });

  it("counts relative paths only on a client created for this backend", () => {
    const text = "client.get('/work-orders/count'); axios.get('/elsewhere'); fetch('/static/x');";
    expect(scan(text)).toEqual([]);
    expect(scan(text, true)).toEqual([["get", "/work-orders/count"]]);
    expect(scanner.providesClient("export const client = axios.create({ baseURL: import.meta.env.VITE_API_HOST });")).toBe(true);
    expect(scanner.providesClient("export const client = axios.create({ baseURL: '/api' });")).toBe(false);
  });

  it("resolves each variable to the declaration in scope, not the last one in the file", () => {
    expect(
      scan(
        [
          "function remove() {",
          "  const url = `${env.apiHost}pages/${id}/delete-docs`;",
          "  return http.delete(url);",
          "}",
          "function annotate() {",
          "  const url = `${env.apiHost}pages/${id}/add-notes`;",
          "  return http.put(url);",
          "}"
        ].join("\n")
      )
    ).toEqual([
      ["delete", "/pages/{}/delete-docs"],
      ["put", "/pages/{}/add-notes"]
    ]);
  });

  it("records requests to the bare base only when they say their method", () => {
    expect(
      scan(
        [
          "fetch(env.apiHost, { method: 'POST', body });",
          "const url = env.apiHost;",
          "this.http.raw(url, { method: 'POST' });",
          "window.open(env.apiHost);",
          "this.http.raw(`${env.apiHost}reports`, { method: 'PUT' });"
        ].join("\n")
      )
    ).toEqual([
      ["post", "/"],
      ["post", "/"],
      ["put", "/reports"]
    ]);
  });

  it("finds helpers that prefix the base URL, directly or by passing their argument on", () => {
    const service = [
      "export default class FetchService extends Service {",
      "  post(url, options) { return this.request(url, { ...options, method: 'POST' }); }",
      "  renderer(url, options) { return this.request(`${env.rendererHost}${url}`, options); }",
      "  async request(_url, options) {",
      "    const url = _url.includes('://') ? _url : `${env.apiHost}${_url}`;",
      "    return globalThis.fetch(url, options);",
      "  }",
      "}"
    ].join("\n");
    expect(Array.from(scanner.wrapperFunctions("fetch.ts", service)).sort()).toEqual(["post", "request"]);
    expect(Array.from(new UrlCallScanner(["rendererHost"]).wrapperFunctions("fetch.ts", service))).toEqual(["renderer"]);
    // The helper's own `${base}${url}` names no route.
    expect(scan(service)).toEqual([]);
  });

  it("counts relative paths passed to injected or imported helpers", () => {
    const context = {
      ...NO_CLIENT,
      wrapperReceivers: new Map([["fetch", new Set(["post", "request"])]]),
      wrapperFunctions: new Set(["apiGet"])
    };
    const text = [
      "this.fetch.post(`users/${name}/favorites`, { data });",
      "this.fetch.request('stencils/svg', { method: 'PUT' });",
      "this.fetch.renderer('/');",
      "this.other.post('users');",
      "this.fetch.request('https://example.com/x');",
      "apiGet('/menu');"
    ].join("\n");
    expect(scanner.scan("file.ts", text, context).map((call) => [call.method, call.path])).toEqual([
      ["post", "/users/{}/favorites"],
      ["put", "/stencils/svg"],
      [null, "/menu"]
    ]);
  });

  it("ignores files that never mention the backend", () => {
    expect(scan("fetch(`${OTHER_HOST}/users/${id}`);")).toEqual([]);
  });
});

describe("route matching", () => {
  const routes = [
    route("get", "/assets/{id}"),
    route("get", "/assets/batch"),
    route("put", "/users/{username}/settings/{app?}"),
    route("get", "/s3*"),
    route("post", "/assets/{id}"),
    route("all", "/proxy/{target}")
  ];
  const call = (method: string | null, segments: string[]) => ({
    file: "f.ts",
    line: 1,
    method,
    path: "",
    segments: segments.map((segment) =>
      segment === "{}" ? ({ kind: "param" } as const) : segment.includes("{}") ? ({ kind: "dynamic" } as const) : ({ kind: "static", value: segment } as const)
    )
  });
  const match = (method: string | null, segments: string[]) =>
    matchCall(call(method, segments), routes).map((candidate) => `${candidate.httpMethod} ${candidate.path}`);

  it("prefers static segments and only lets interpolated values fill parameters", () => {
    expect(match("get", ["assets", "batch"])).toEqual(["get /assets/batch"]);
    expect(match("get", ["assets", "{}"])).toEqual(["get /assets/{id}"]);
  });

  it("handles optional parameters, wildcards, verbs, and all-method routes", () => {
    expect(match("put", ["users", "{}", "settings"])).toEqual(["put /users/{username}/settings/{app?}"]);
    expect(match("put", ["users", "{}", "settings", "inspect"])).toEqual(["put /users/{username}/settings/{app?}"]);
    expect(match("get", ["s3", "bucket", "{}"])).toEqual(["get /s3*"]);
    expect(match("delete", ["assets", "{}"])).toEqual([]);
    expect(match("patch", ["proxy", "{}"])).toEqual(["all /proxy/{target}"]);
    expect(match(null, ["assets", "{}"])).toEqual(["get /assets/{id}"]);
  });
});
