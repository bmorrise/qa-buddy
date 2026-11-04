import { describe, expect, it } from "vitest";
import type { NestEndpoint } from "./nest-endpoints.js";
import { matchCall, UrlCallScanner } from "./url-calls.js";

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
    scanner.scan("file.ts", text, importsClient).map((call) => [call.method, call.path]);

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
