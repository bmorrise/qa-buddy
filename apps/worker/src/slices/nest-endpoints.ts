import { readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";
import { isApplicationSource } from "./module-graph.js";

const HTTP_DECORATORS: Record<string, string> = {
  Get: "get",
  Post: "post",
  Put: "put",
  Patch: "patch",
  Delete: "delete",
  Options: "options",
  Head: "head",
  All: "all",
  Sse: "get"
};

export interface NestEndpoint {
  /** Repository-relative controller file. */
  file: string;
  controller: string;
  methodKey: string;
  httpMethod: string;
  /** Swagger-style path, for example `/inspection/{id}/sections`. */
  path: string;
  /** Set by `@ApiOperation({ operationId })`, which overrides the method name. */
  explicitOperationId: string | null;
}

function explicitOperationId(decorators: Array<{ name: string; args: readonly ts.Expression[] }>): string | null {
  const apiOperation = decorators.find((decorator) => decorator.name === "ApiOperation");
  const options = apiOperation?.args[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "operationId" &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return null;
}

function decoratorCall(decorator: ts.Decorator): { name: string; args: readonly ts.Expression[] } | null {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return { name: expression.expression.text, args: expression.arguments };
  }
  if (ts.isIdentifier(expression)) return { name: expression.text, args: [] };
  return null;
}

/** Route strings a decorator argument declares; `[""]` when it declares none. */
function routeStrings(argument: ts.Expression | undefined): string[] {
  if (!argument) return [""];
  if (ts.isStringLiteralLike(argument)) return [argument.text];
  if (ts.isArrayLiteralExpression(argument)) {
    const values = argument.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
    return values.length ? values : [""];
  }
  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "path") {
        return routeStrings(property.initializer);
      }
    }
  }
  return [""];
}

export function swaggerPath(prefix: string, route: string): string {
  // Optional groups such as `:id{/:layout}` publish as plain parameters.
  const joined = [prefix, route]
    .flatMap((part) => part.replace(/[{}]/g, "").split("/"))
    .filter(Boolean)
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1).replace(/\?$/, "")}}` : segment))
    .join("/");
  return `/${joined}`;
}

/** Controller endpoints declared in one source file. Excluded endpoints are skipped. */
export function parseControllerEndpoints(file: string, text: string): NestEndpoint[] {
  if (!text.includes("@Controller")) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const endpoints: NestEndpoint[] = [];

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const classDecorators = (ts.getDecorators(statement) ?? []).map(decoratorCall).filter(Boolean) as Array<{
      name: string;
      args: readonly ts.Expression[];
    }>;
    const controllerDecorator = classDecorators.find((decorator) => decorator.name === "Controller");
    if (!controllerDecorator) continue;
    if (classDecorators.some((decorator) => decorator.name === "ApiExcludeController")) continue;
    const prefixes = routeStrings(controllerDecorator.args[0]);

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const decorators = (ts.getDecorators(member) ?? []).map(decoratorCall).filter(Boolean) as Array<{
        name: string;
        args: readonly ts.Expression[];
      }>;
      if (decorators.some((decorator) => decorator.name === "ApiExcludeEndpoint")) continue;
      for (const decorator of decorators) {
        const httpMethod = HTTP_DECORATORS[decorator.name];
        if (!httpMethod) continue;
        for (const prefix of prefixes) {
          for (const route of routeStrings(decorator.args[0])) {
            endpoints.push({
              file,
              controller: statement.name.text,
              methodKey: member.name.text,
              httpMethod,
              path: swaggerPath(prefix, route),
              explicitOperationId: explicitOperationId(decorators)
            });
          }
        }
      }
    }
  }
  return endpoints;
}

/** Every controller endpoint in a NestJS workspace. */
export async function findNestEndpoints(repositoryDirectory: string, workspaceDirectory: string): Promise<NestEndpoint[]> {
  const files = await fg(["**/*.ts"], {
    cwd: path.join(repositoryDirectory, workspaceDirectory),
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.d.ts"],
    followSymbolicLinks: false
  });
  const endpoints: NestEndpoint[] = [];
  for (const file of files.sort()) {
    const relativePath = path.posix.join(workspaceDirectory, file);
    if (!isApplicationSource(relativePath)) continue;
    const text = readFileSync(path.join(repositoryDirectory, relativePath), "utf8");
    endpoints.push(...parseControllerEndpoints(relativePath, text));
  }
  return endpoints;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join("");
}

/**
 * Operation ids an endpoint may be published under. idp-api-service uses the
 * method name and, when another endpoint already took that name, appends the
 * path's static segments (or the HTTP verb). Which duplicate keeps the bare
 * name depends on module registration order, so every form is a candidate.
 */
export function candidateOperationIds(endpoint: NestEndpoint): string[] {
  const base = endpoint.explicitOperationId ?? endpoint.methodKey;
  const suffix = endpoint.path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("{"))
    .map(toPascalCase)
    .join("");
  const deduplicated = suffix ? `${base}${suffix}` : `${base}${endpoint.httpMethod.toUpperCase()}`;
  return [base, deduplicated, `${deduplicated}2`, `${deduplicated}3`];
}

/** Runtime export names orval's react-query client generates for one operation id. */
export function orvalExportNames(operationId: string): string[] {
  const pascal = `${operationId.charAt(0).toUpperCase()}${operationId.slice(1)}`;
  return [
    operationId,
    `use${pascal}`,
    `use${pascal}Suspense`,
    `use${pascal}Infinite`,
    `use${pascal}SuspenseInfinite`,
    `prefetch${pascal}`,
    `prefetch${pascal}Infinite`,
    `get${pascal}QueryKey`,
    `get${pascal}InfiniteQueryKey`,
    `get${pascal}QueryOptions`,
    `get${pascal}SuspenseQueryOptions`,
    `get${pascal}InfiniteQueryOptions`,
    `get${pascal}SuspenseInfiniteQueryOptions`,
    `get${pascal}MutationOptions`,
    `get${pascal}Url`
  ];
}

/**
 * Index from generated client export name to the endpoints it may call. Each
 * endpoint contributes the operation ids it may be published under: exactly
 * one when module order is known, every candidate otherwise.
 */
export function buildClientNameIndex(operationIds: Map<NestEndpoint, string[]>): Map<string, NestEndpoint[]> {
  const index = new Map<string, NestEndpoint[]>();
  for (const [endpoint, ids] of operationIds) {
    for (const operationId of ids) {
      for (const name of orvalExportNames(operationId)) {
        const existing = index.get(name);
        if (existing) {
          if (!existing.includes(endpoint)) existing.push(endpoint);
        } else {
          index.set(name, [endpoint]);
        }
      }
    }
  }
  return index;
}
