import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isApplicationSource, siblingModules, type ModuleResolver } from "./module-graph.js";
import type { NestEndpoint } from "./nest-endpoints.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

/** A route in an Express app, in the same shape as a NestJS endpoint. */
export type ExpressEndpoint = NestEndpoint;

type MountTarget = { kind: "module"; specifier: string } | { kind: "local"; name: string } | { kind: "siblings" };

interface ExpressFile {
  /** Local identifiers holding an Express app or Router. */
  routers: Set<string>;
  /** The router assigned to `module.exports`, if any. */
  exported: string | null;
  endpoints: Array<{ router: string; method: string; path: string }>;
  mounts: Array<{ router: string; prefix: string; target: MountTarget }>;
}

const scriptKind = (file: string): ts.ScriptKind =>
  file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;

function literalStrings(node: ts.Expression | undefined): string[] | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
    return values.length ? values : null;
  }
  return null;
}

function requireSpecifier(node: ts.Expression): string | null | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "require") return undefined;
  const [argument] = node.arguments;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function isRouterFactory(node: ts.Expression, expressNames: Set<string>): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "Router" || expressNames.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "Router";
  return false;
}

/** Reads the routers, routes, and mounts declared in one Express source file. */
export function parseExpressFile(file: string, text: string): ExpressFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const result: ExpressFile = { routers: new Set(), exported: null, endpoints: [], mounts: [] };
  const requires = new Map<string, string>();
  const expressNames = new Set<string>();
  // `fs.readdirSync(__dirname).forEach((file) => router.use(require(`./${file}`)))`
  const dynamicSiblings = /readdirSync\(\s*__dirname\s*\)/.test(text);

  // First pass: declarations, so later references resolve regardless of order.
  const declare = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const specifier = requireSpecifier(node.initializer);
      if (specifier) {
        requires.set(node.name.text, specifier);
        if (specifier === "express") expressNames.add(node.name.text);
      }
      if (isRouterFactory(node.initializer, expressNames)) result.routers.add(node.name.text);
    }
    ts.forEachChild(node, declare);
  };
  declare(source);

  /** Path of a `router.route('/x')` chain, if `node` is one. */
  const routeChain = (node: ts.Expression): { router: string; path: string } | null => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    const callee = node.expression;
    if (callee.name.text === "route" && ts.isIdentifier(callee.expression) && result.routers.has(callee.expression.text)) {
      const [first] = literalStrings(node.arguments[0]) ?? [];
      return first === undefined ? null : { router: callee.expression.text, path: first };
    }
    return HTTP_METHODS.has(callee.name.text) ? routeChain(callee.expression) : null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const owner = callee.expression;
      if (ts.isIdentifier(owner) && result.routers.has(owner.text)) {
        if (HTTP_METHODS.has(method)) {
          for (const routePath of literalStrings(node.arguments[0]) ?? []) {
            result.endpoints.push({ router: owner.text, method, path: routePath });
          }
        } else if (method === "use") {
          const prefixes = literalStrings(node.arguments[0]);
          const targets = prefixes ? node.arguments.slice(1) : node.arguments;
          for (const target of targets) {
            let mount: MountTarget | null = null;
            if (ts.isIdentifier(target)) {
              if (requires.has(target.text)) mount = { kind: "module", specifier: requires.get(target.text)! };
              else if (result.routers.has(target.text)) mount = { kind: "local", name: target.text };
            } else {
              const specifier = requireSpecifier(target);
              if (specifier) mount = { kind: "module", specifier };
              else if (specifier === null && dynamicSiblings) mount = { kind: "siblings" };
            }
            if (!mount) continue;
            for (const prefix of prefixes ?? [""]) result.mounts.push({ router: owner.text, prefix, target: mount });
          }
        }
      } else if (HTTP_METHODS.has(method)) {
        const chain = routeChain(owner);
        if (chain) result.endpoints.push({ router: chain.router, method, path: chain.path });
      }
    }
    // module.exports = router
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      node.left.name.text === "exports" &&
      ts.isIdentifier(node.right)
    ) {
      result.exported = node.right.text;
    }
    // export default router
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) result.exported = node.expression.text;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

/** Joins Express path fragments into a swagger-style path, `:id` becoming `{id}`. */
export function joinExpressPath(...parts: string[]): string {
  const segments = parts
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .map((segment) => (/^:[A-Za-z0-9_]+\??$/.test(segment) ? `{${segment.slice(1)}}` : segment));
  return `/${segments.join("/")}`;
}

/**
 * Every route an Express app serves, found by following `app.use` and
 * `router.use` mounts from the entry file. Routers that are never mounted are
 * not served, so they are left out.
 */
export function findExpressEndpoints(
  repositoryDirectory: string,
  backendDirectory: string,
  entryFile: string,
  resolver: ModuleResolver
): ExpressEndpoint[] {
  const parsed = new Map<string, ExpressFile>();
  const parse = (file: string): ExpressFile => {
    const cached = parsed.get(file);
    if (cached) return cached;
    let value: ExpressFile;
    try {
      value = parseExpressFile(file, readFileSync(file, "utf8"));
    } catch {
      value = { routers: new Set(), exported: null, endpoints: [], mounts: [] };
    }
    parsed.set(file, value);
    return value;
  };

  const backendRoot = path.join(repositoryDirectory, backendDirectory);
  const inside = (file: string): boolean =>
    file.startsWith(`${backendRoot}${path.sep}`) && isApplicationSource(resolver.relative(file));

  const endpoints = new Map<string, ExpressEndpoint>();
  const visited = new Set<string>();

  const walk = (file: string, router: string | null, prefix: string): void => {
    if (!inside(file)) return;
    const info = parse(file);
    const active = router ?? info.exported ?? Array.from(info.routers)[0] ?? null;
    if (!active) return;
    const key = `${file}#${active}#${prefix}`;
    if (visited.has(key)) return;
    visited.add(key);

    for (const endpoint of info.endpoints) {
      if (endpoint.router !== active) continue;
      const routePath = joinExpressPath(prefix, endpoint.path);
      const relativeFile = resolver.relative(file);
      const id = `${endpoint.method} ${routePath} ${relativeFile}`;
      if (!endpoints.has(id)) {
        endpoints.set(id, {
          file: relativeFile,
          controller: path.posix.basename(relativeFile).replace(/\.[cm]?[jt]s$/, ""),
          methodKey: "",
          httpMethod: endpoint.method,
          path: routePath,
          explicitOperationId: null
        });
      }
    }
    for (const mount of info.mounts) {
      if (mount.router !== active) continue;
      const nextPrefix = joinExpressPath(prefix, mount.prefix);
      if (mount.target.kind === "local") {
        walk(file, mount.target.name, nextPrefix);
      } else if (mount.target.kind === "module") {
        const target = resolver.resolve(file, mount.target.specifier);
        if (target) walk(target, null, nextPrefix);
      } else {
        for (const sibling of siblingModules(file)) walk(sibling, null, nextPrefix);
      }
    }
  };

  walk(path.join(backendRoot, entryFile), null, "");
  return Array.from(endpoints.values());
}
