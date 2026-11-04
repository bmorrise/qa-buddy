import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ModuleResolver } from "./module-graph.js";
import type { NestEndpoint } from "./nest-endpoints.js";

/** A class reference resolved to the file that declares it. */
interface ClassRef {
  file: string;
  name: string;
}

interface ModuleDeclaration {
  imports: ClassRef[];
  controllers: ClassRef[];
}

const refKey = (ref: ClassRef): string => `${ref.file}#${ref.name}`;

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join("");
}

/**
 * Reads the `@Module` declarations in one file, resolving each referenced
 * class through the file's imports. `X.forRoot()`, `forwardRef(() => X)` and
 * spreads of local array constants are unwrapped.
 */
function parseModuleFile(
  absolutePath: string,
  text: string,
  resolver: ModuleResolver
): Map<string, ModuleDeclaration> {
  const modules = new Map<string, ModuleDeclaration>();
  if (!text.includes("@Module")) return modules;
  const source = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  const importedClasses = new Map<string, ClassRef>();
  const localArrays = new Map<string, ts.ArrayLiteralExpression>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const target = resolver.resolve(absolutePath, statement.moduleSpecifier.text);
      if (!target) continue;
      for (const element of bindings.elements) {
        importedClasses.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        let initializer = declaration.initializer;
        while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) {
          initializer = initializer.expression;
        }
        if (ts.isIdentifier(declaration.name) && initializer && ts.isArrayLiteralExpression(initializer)) {
          localArrays.set(declaration.name.text, initializer);
        }
      }
    }
  }

  const refFor = (identifier: string): ClassRef => importedClasses.get(identifier) ?? { file: absolutePath, name: identifier };

  const collect = (array: ts.ArrayLiteralExpression, seen = new Set<string>()): ClassRef[] => {
    const refs: ClassRef[] = [];
    for (const element of array.elements) {
      let expression: ts.Expression = element;
      if (ts.isSpreadElement(expression)) {
        if (ts.isIdentifier(expression.expression) && !seen.has(expression.expression.text)) {
          const local = localArrays.get(expression.expression.text);
          if (local) refs.push(...collect(local, new Set([...seen, expression.expression.text])));
        }
        continue;
      }
      // forwardRef(() => X)
      if (
        ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "forwardRef" &&
        expression.arguments[0] &&
        ts.isArrowFunction(expression.arguments[0]) &&
        !ts.isBlock(expression.arguments[0].body)
      ) {
        expression = expression.arguments[0].body;
      }
      // X.forRoot(...), X.register(...)
      if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
        expression = expression.expression.expression;
      }
      if (ts.isIdentifier(expression)) refs.push(refFor(expression.text));
    }
    return refs;
  };

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "Module") continue;
      const options = call.arguments[0];
      const declaration: ModuleDeclaration = { imports: [], controllers: [] };
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          let value = property.initializer;
          if (ts.isIdentifier(value) && localArrays.has(value.text)) value = localArrays.get(value.text)!;
          if (!ts.isArrayLiteralExpression(value)) continue;
          if (property.name.text === "imports") declaration.imports = collect(value);
          if (property.name.text === "controllers") declaration.controllers = collect(value);
        }
      }
      modules.set(refKey({ file: absolutePath, name: statement.name.text }), declaration);
    }
  }
  return modules;
}

/**
 * Orders endpoints the way @nestjs/swagger encounters them: modules in the
 * scanner's pre-order walk of `imports` from the root module, controllers in
 * declaration order, then methods in class order. Endpoints whose module was
 * not reached are returned separately.
 */
export function orderEndpoints(
  repositoryDirectory: string,
  rootModuleFile: string,
  endpoints: NestEndpoint[],
  resolver: ModuleResolver
): { ordered: NestEndpoint[]; unreached: NestEndpoint[] } {
  const declarations = new Map<string, ModuleDeclaration>();
  const loadedFiles = new Set<string>();
  const declarationFor = (ref: ClassRef): ModuleDeclaration | undefined => {
    if (!loadedFiles.has(ref.file)) {
      loadedFiles.add(ref.file);
      try {
        for (const [key, value] of parseModuleFile(ref.file, readFileSync(ref.file, "utf8"), resolver)) {
          declarations.set(key, value);
        }
      } catch {
        // Unreadable files simply contribute no modules.
      }
    }
    return declarations.get(refKey(ref));
  };

  const rootFile = path.join(repositoryDirectory, rootModuleFile);
  const root = Array.from(parseModuleFile(rootFile, readFileSync(rootFile, "utf8"), resolver).keys())[0];
  if (!root) return { ordered: [], unreached: endpoints };
  loadedFiles.add(rootFile);
  for (const [key, value] of parseModuleFile(rootFile, readFileSync(rootFile, "utf8"), resolver)) {
    declarations.set(key, value);
  }

  const endpointsByController = new Map<string, NestEndpoint[]>();
  for (const endpoint of endpoints) {
    const key = refKey({ file: path.join(repositoryDirectory, endpoint.file), name: endpoint.controller });
    const list = endpointsByController.get(key) ?? [];
    list.push(endpoint);
    endpointsByController.set(key, list);
  }

  const ordered: NestEndpoint[] = [];
  const placed = new Set<NestEndpoint>();
  const visited = new Set<string>();
  const [rootPath, rootName] = root.split("#") as [string, string];
  const stack: ClassRef[] = [{ file: rootPath, name: rootName }];
  // Iterative pre-order walk; children are pushed in reverse to keep declaration order.
  while (stack.length) {
    const ref = stack.pop()!;
    const key = refKey(ref);
    if (visited.has(key)) continue;
    visited.add(key);
    const declaration = declarationFor(ref);
    if (!declaration) continue;
    for (const controller of declaration.controllers) {
      for (const endpoint of endpointsByController.get(refKey(controller)) ?? []) {
        if (placed.has(endpoint)) continue;
        placed.add(endpoint);
        ordered.push(endpoint);
      }
    }
    for (let index = declaration.imports.length - 1; index >= 0; index -= 1) {
      stack.push(declaration.imports[index]!);
    }
  }

  return { ordered, unreached: endpoints.filter((endpoint) => !placed.has(endpoint)) };
}

/**
 * Reproduces idp-api-service's operation ids: the explicit id or method name,
 * de-duplicated in swagger path order by appending the path's static segments
 * (or the HTTP verb) and then a counter. Mirrors `ensureUniqueOperationIds`.
 */
export function assignOperationIds(ordered: NestEndpoint[]): Map<NestEndpoint, string> {
  // @nestjs/swagger groups routes by path (first appearance wins the position),
  // then by method, with a later duplicate path+method replacing the earlier.
  const byPath = new Map<string, Map<string, NestEndpoint>>();
  for (const endpoint of ordered) {
    const methods = byPath.get(endpoint.path) ?? new Map<string, NestEndpoint>();
    methods.set(endpoint.httpMethod, endpoint);
    byPath.set(endpoint.path, methods);
  }

  const assigned = new Map<NestEndpoint, string>();
  const seen = new Set<string>();
  for (const [routePath, methods] of byPath) {
    for (const [method, endpoint] of methods) {
      let operationId = endpoint.explicitOperationId ?? endpoint.methodKey;
      if (seen.has(operationId)) {
        const suffix = routePath
          .split("/")
          .filter(Boolean)
          .filter((segment) => !segment.startsWith("{"))
          .map(toPascalCase)
          .join("");
        const base = suffix ? `${operationId}${suffix}` : `${operationId}${method.toUpperCase()}`;
        let unique = base;
        let counter = 2;
        while (seen.has(unique)) {
          unique = `${base}${counter}`;
          counter += 1;
        }
        operationId = unique;
      }
      seen.add(operationId);
      assigned.set(endpoint, operationId);
    }
  }
  return assigned;
}
