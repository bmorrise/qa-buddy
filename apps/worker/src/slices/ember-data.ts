import path from "node:path";
import ts from "typescript";
import { buildUrlCall, type UrlCall } from "./url-calls.js";

/**
 * Requests an Ember app makes through Ember Data, worked out from how the app
 * uses the store and how its adapters build URLs:
 *
 * - `findRecord('company', id)`, `query('alert', {...})`, `createRecord('asset')`
 *   and friends, called on the store or as request builders, become the
 *   adapter's URL for that model and operation;
 * - the adapter (`app/adapters/<model>`, else `application`) supplies `host`
 *   (matched to a backend by its base URL name), `namespace`, `pathForType`,
 *   and any overridden operation, whose `this.buildURL(...)`/`this.ajax(...)`
 *   calls are evaluated for the model at hand;
 * - every model the app touches may be saved or deleted (`record.save()` does
 *   not say which model it is), and async relationships load related records,
 *   so those requests are inferred.
 */
export interface EmberDataRequest {
  /** The base URL name the adapter's host uses, which picks the backend. */
  baseName: string;
  call: UrlCall;
  /** Where the request comes from, for display: `file:line`, or a model file with a note. */
  site: string;
  /** True for requests assumed rather than seen: save/delete and relationship loads. */
  inferred: boolean;
}

type Operation = "findRecord" | "findAll" | "query" | "queryRecord" | "createRecord" | "updateRecord" | "deleteRecord";

const OPERATIONS = new Set<string>(["findRecord", "findAll", "query", "queryRecord", "createRecord", "updateRecord", "deleteRecord"]);
/** Store calls and request builders that name a model, and the adapter operation each one runs. */
const STORE_CALLS: Record<string, Operation | null> = {
  findRecord: "findRecord",
  findAll: "findAll",
  query: "query",
  queryRecord: "queryRecord",
  createRecord: "createRecord",
  peekRecord: null,
  peekAll: null
};

interface Adapter {
  name: string;
  parent: string | null;
  kind: "json-api" | "rest" | null;
  /** undefined: not set by this adapter; null: set to something that is not a known base URL. */
  host: string | null | undefined;
  namespace: string | undefined;
  pathForType: string | undefined;
  overrides: Map<Operation, ts.MethodDeclaration>;
}

interface Resolved {
  kind: "json-api" | "rest";
  host: string | null;
  namespace: string;
  pathForType: string | undefined;
  /** Overridden operations, nearest adapter first. */
  overrides: Map<Operation, ts.MethodDeclaration>;
}

const PARAM = "\u0000";

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Ember's pluralize for the common cases: `company` → `companies`, `alert` → `alerts`. */
export function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

const camelize = (text: string): string => text.replace(/[-_/](\w)/g, (_, letter: string) => letter.toUpperCase());

function modelNameOf(appDirectory: string, file: string, folder: string): string {
  return path
    .relative(path.join(appDirectory, folder), file)
    .split(path.sep)
    .join("/")
    .replace(/\.(?:[cm]?[jt]s|g[jt]s)$/, "");
}

function parseAdapter(name: string, source: ts.SourceFile, baseNames: string[]): Adapter {
  const adapter: Adapter = { name, parent: null, kind: null, host: undefined, namespace: undefined, pathForType: undefined, overrides: new Map() };
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause?.name) {
      imports.set(statement.importClause.name.text, statement.moduleSpecifier.text);
    }
  }
  const baseOf = (expression: ts.Expression): string | null => {
    let found: string | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && baseNames.includes(node.text)) found = node.text;
      else ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };
  const stringOf = (expression: ts.Expression): string | undefined => {
    const inner = unwrap(expression);
    return ts.isStringLiteralLike(inner) ? inner.text : undefined;
  };

  const declaration = source.statements.find(ts.isClassDeclaration);
  if (!declaration) return adapter;
  const heritage = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (heritage && ts.isIdentifier(heritage.expression)) {
    const specifier = imports.get(heritage.expression.text) ?? "";
    if (/adapter\/json-api$/.test(specifier)) adapter.kind = "json-api";
    else if (/adapter\/rest$/.test(specifier)) adapter.kind = "rest";
    else {
      const match = /(?:^\.\/|\/adapters\/)([^/]+(?:\/[^/]+)*)$/.exec(specifier);
      if (match) adapter.parent = match[1]!;
    }
  }

  const assign = (property: string, value: ts.Expression): void => {
    if (property === "host") adapter.host = baseOf(value);
    if (property === "namespace") adapter.namespace = stringOf(value) ?? adapter.namespace;
  };
  for (const member of declaration.members) {
    const memberName = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
    if (ts.isPropertyDeclaration(member) && memberName && member.initializer) assign(memberName, member.initializer);
    if (ts.isGetAccessorDeclaration(member) && memberName === "host" && member.body) {
      const returned = member.body.statements.find(ts.isReturnStatement)?.expression;
      if (returned) assign("host", returned);
    }
    if (ts.isConstructorDeclaration(member) && member.body) {
      for (const statement of member.body.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
        const { left, right, operatorToken } = statement.expression;
        if (
          operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(left) &&
          left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          assign(left.name.text, right);
        }
      }
    }
    if (ts.isMethodDeclaration(member) && memberName && member.body) {
      if (memberName === "pathForType") {
        const returned = member.body.statements.find(ts.isReturnStatement)?.expression;
        const value = returned ? stringOf(returned) : undefined;
        if (value !== undefined) adapter.pathForType = value;
      } else if (OPERATIONS.has(memberName)) {
        adapter.overrides.set(memberName as Operation, member);
      }
    }
  }
  return adapter;
}

function resolveAdapter(adapters: Map<string, Adapter>, model: string): Resolved | null {
  let current = adapters.get(model) ?? adapters.get("application") ?? null;
  if (!current) return null;
  const resolved: Resolved = { kind: "json-api", host: null, namespace: "", pathForType: undefined, overrides: new Map() };
  let hostSet = false;
  let namespaceSet = false;
  const seen = new Set<string>();
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
    if (!hostSet && current.host !== undefined) {
      resolved.host = current.host;
      hostSet = true;
    }
    if (!namespaceSet && current.namespace !== undefined) {
      resolved.namespace = current.namespace;
      namespaceSet = true;
    }
    resolved.pathForType ??= current.pathForType;
    for (const [operation, method] of current.overrides) if (!resolved.overrides.has(operation)) resolved.overrides.set(operation, method);
    if (current.kind) resolved.kind = current.kind;
    current = current.parent ? (adapters.get(current.parent) ?? null) : null;
  }
  return resolved;
}

const DEFAULTS: Record<Operation, { method: string; id: boolean }> = {
  findRecord: { method: "get", id: true },
  findAll: { method: "get", id: false },
  query: { method: "get", id: false },
  queryRecord: { method: "get", id: false },
  createRecord: { method: "post", id: false },
  updateRecord: { method: "patch", id: true },
  deleteRecord: { method: "delete", id: true }
};

/**
 * Works out every request an Ember Data operation can make for one model,
 * evaluating an overridden adapter method when there is one.
 */
function operationRequests(
  adapters: Map<string, Adapter>,
  model: string,
  operation: Operation
): Array<{ host: string; method: string; tokens: string }> {
  const adapter = resolveAdapter(adapters, model);
  if (!adapter?.host) return [];
  const host = adapter.host;
  const prefixFor = (name: string): string => {
    const target = name === model ? adapter : (resolveAdapter(adapters, name) ?? adapter);
    const pathForType = target.pathForType ?? (target.kind === "rest" ? camelize(pluralize(name)) : pluralize(name));
    return `/${[target.namespace, pathForType].filter(Boolean).join("/")}`;
  };
  const defaultRequest = (op: Operation): { host: string; method: string; tokens: string } => {
    const { method, id } = DEFAULTS[op];
    return { host, method: op === "updateRecord" && adapter.kind === "rest" ? "put" : method, tokens: prefixFor(model) + (id ? `/${PARAM}` : "") };
  };

  const override = adapter.overrides.get(operation);
  if (!override?.body) return [defaultRequest(operation)];

  const parameters = override.parameters.map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : ""));
  const queryParameter = ["query", "queryRecord", "findAll"].includes(operation) ? parameters[2] : undefined;
  const requests: Array<{ host: string; method: string; tokens: string }> = [];

  type Env = Map<string, string[]>;
  const rootIdentifier = (expression: ts.Expression): string | null => {
    let current = unwrap(expression);
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
    return ts.isIdentifier(current) ? current.text : null;
  };

  /** Every URL token string an expression can hold; empty when unknown. */
  const tokensOf = (node: ts.Expression, env: Env): string[] => {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) return env.get(expression.text) ?? [];
    if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
        callee.name.text === "buildURL"
      ) {
        const [modelArgument, idArgument] = expression.arguments.map(unwrap);
        const target = modelArgument && ts.isStringLiteralLike(modelArgument) ? modelArgument.text : model;
        const absent =
          !idArgument ||
          idArgument.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(idArgument) && idArgument.text === "undefined") ||
          (queryParameter !== undefined && rootIdentifier(idArgument) === queryParameter);
        return [prefixFor(target) + (absent ? "" : `/${PARAM}`)];
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toString") return tokensOf(callee.expression, env);
      return [];
    }
    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "URL" && expression.arguments?.[0]) {
      return tokensOf(expression.arguments[0], env);
    }
    if (ts.isTemplateExpression(expression) && expression.head.text === "") {
      const [first, ...rest] = expression.templateSpans;
      if (!first) return [];
      const suffix = first.literal.text + rest.map((span) => PARAM + span.literal.text).join("");
      return tokensOf(first.expression, env).map((prefix) => prefix + suffix);
    }
    return [];
  };

  /** true/false when a condition only depends on the model name, otherwise null. */
  const evaluate = (node: ts.Expression): boolean | null => {
    const expression = unwrap(node);
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = evaluate(expression.operand);
      return inner === null ? null : !inner;
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const left = evaluate(expression.left);
        const right = evaluate(expression.right);
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
          if (left === false || right === false) return false;
          return left === true && right === true ? true : null;
        }
        if (left === true || right === true) return true;
        return left === false && right === false ? false : null;
      }
      const equality = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(operator);
      const inequality = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(operator);
      if (equality || inequality) {
        const sides = [unwrap(expression.left), unwrap(expression.right)];
        const nameSide = sides.find((side) => ts.isPropertyAccessExpression(side) && side.name.text === "modelName");
        const literal = sides.find(ts.isStringLiteralLike);
        if (nameSide && literal) return (literal.text === model) === equality;
      }
      return null;
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "includes" &&
      ts.isArrayLiteralExpression(unwrap(expression.expression.expression))
    ) {
      const argument = expression.arguments[0] ? unwrap(expression.arguments[0]) : undefined;
      const list = unwrap(expression.expression.expression) as ts.ArrayLiteralExpression;
      if (argument && ts.isPropertyAccessExpression(argument) && argument.name.text === "modelName" && list.elements.every(ts.isStringLiteralLike)) {
        return list.elements.some((element) => (element as ts.StringLiteralLike).text === model);
      }
    }
    return null;
  };

  /** Records `this.ajax(url, 'GET')` and `super.<operation>(...)` calls inside an expression. */
  const collect = (node: ts.Node, env: Env): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: receiver, name } = node.expression;
      if (receiver.kind === ts.SyntaxKind.ThisKeyword && name.text === "ajax" && node.arguments[0]) {
        const methodArgument = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
        const method = methodArgument && ts.isStringLiteralLike(methodArgument) ? methodArgument.text.toLowerCase() : "get";
        for (const tokens of tokensOf(node.arguments[0], env)) requests.push({ host, method, tokens });
      } else if (receiver.kind === ts.SyntaxKind.SuperKeyword && OPERATIONS.has(name.text)) {
        requests.push(defaultRequest(name.text as Operation));
      }
    }
    ts.forEachChild(node, (child) => collect(child, env));
  };

  const merge = (target: Env, ...branches: Env[]): void => {
    const names = new Set(branches.flatMap((branch) => Array.from(branch.keys())));
    for (const name of names) {
      target.set(name, Array.from(new Set(branches.flatMap((branch) => branch.get(name) ?? target.get(name) ?? []))));
    }
  };

  /** Walks statements in order, returning true when the statement always returns or throws. */
  const walk = (node: ts.Node, env: Env): boolean => {
    if (ts.isBlock(node)) {
      for (const statement of node.statements) if (walk(statement, env)) return true;
      return false;
    }
    if (ts.isIfStatement(node)) {
      collect(node.expression, env);
      const condition = evaluate(node.expression);
      const thenEnv: Env = new Map(env);
      const elseEnv: Env = new Map(env);
      const thenEnds = condition !== false ? walk(node.thenStatement, thenEnv) : false;
      const elseEnds = condition !== true && node.elseStatement ? walk(node.elseStatement, elseEnv) : false;
      if (condition === true) {
        merge(env, thenEnv);
        return thenEnds;
      }
      if (condition === false) {
        merge(env, elseEnv);
        return elseEnds;
      }
      // Only branches that fall through carry their variables on.
      const open = [thenEnds ? null : thenEnv, elseEnds ? null : elseEnv].filter((branch): branch is Env => branch !== null);
      if (open.length) merge(env, ...open);
      return thenEnds && elseEnds;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer) collect(declaration.initializer, env);
        if (ts.isIdentifier(declaration.name)) {
          env.set(declaration.name.text, declaration.initializer ? tokensOf(declaration.initializer, env) : []);
        }
      }
      return false;
    }
    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.expression.left)
    ) {
      collect(node.expression.right, env);
      env.set(node.expression.left.text, tokensOf(node.expression.right, env));
      return false;
    }
    if (ts.isTryStatement(node)) {
      const tryEnds = walk(node.tryBlock, env);
      if (node.catchClause) walk(node.catchClause.block, env);
      const finallyEnds = node.finallyBlock ? walk(node.finallyBlock, env) : false;
      return finallyEnds || (tryEnds && !node.catchClause);
    }
    collect(node, env);
    return ts.isReturnStatement(node) || ts.isThrowStatement(node);
  };
  walk(override.body, new Map());
  return requests;
}

/**
 * The Ember Data requests of one Ember app.
 *
 * @param appDirectory absolute path of the app's `app/` folder
 * @param files the app's source files to look for store calls in
 * @param baseNames every configured backend's base URL names
 */
export function findEmberDataRequests(
  appDirectory: string,
  files: string[],
  readText: (file: string) => string,
  relative: (file: string) => string,
  baseNames: string[]
): EmberDataRequest[] {
  const inFolder = (folder: string): string[] => files.filter((file) => file.startsWith(path.join(appDirectory, folder) + path.sep));
  const parse = (file: string): ts.SourceFile =>
    ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true, /\.(?:[cm]?js|gjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

  const modelFiles = new Map(inFolder("models").map((file) => [modelNameOf(appDirectory, file, "models"), file] as const));
  if (modelFiles.size === 0) return [];
  const adapters = new Map<string, Adapter>();
  for (const file of inFolder("adapters")) {
    const name = modelNameOf(appDirectory, file, "adapters");
    adapters.set(name, parseAdapter(name, parse(file), baseNames));
  }

  const requests: EmberDataRequest[] = [];
  const seen = new Set<string>();
  const emit = (model: string, operation: Operation, site: string, file: string, line: number, inferred: boolean): void => {
    for (const request of operationRequests(adapters, model, operation)) {
      const call = buildUrlCall(file, line, request.method, request.tokens);
      if (!call) continue;
      const key = `${request.host} ${call.method} ${call.path} ${site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push({ baseName: request.host, call, site, inferred });
    }
  };

  // Models the app touches, from store calls and request builders.
  const touched = new Set<string>();
  const adapterFolder = path.join(appDirectory, "adapters") + path.sep;
  for (const file of files) {
    if (file.startsWith(adapterFolder)) continue;
    const text = readText(file);
    if (!/\b(findRecord|findAll|query|queryRecord|createRecord|peekRecord|peekAll)\s*\(/.test(text)) continue;
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[0]) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        const first = unwrap(node.arguments[0]);
        if (name && name in STORE_CALLS && ts.isStringLiteralLike(first) && modelFiles.has(first.text)) {
          touched.add(first.text);
          const operation = STORE_CALLS[name];
          if (operation) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            emit(first.text, operation, `${relative(file)}:${line}`, file, line, false);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Async relationships load the related records of every model reached.
  const queue = Array.from(touched);
  while (queue.length) {
    const model = queue.pop()!;
    const file = modelFiles.get(model)!;
    for (const match of readText(file).matchAll(/@(?:belongsTo|hasMany)\(\s*['"]([^'"]+)['"]\s*(?:,\s*\{([^}]*)\})?/g)) {
      const related = match[1]!;
      if (/async\s*:\s*false/.test(match[2] ?? "") || !modelFiles.has(related)) continue;
      emit(related, "findRecord", `${relative(file)} (async relationship to ${related})`, file, 1, true);
      if (!touched.has(related)) {
        touched.add(related);
        queue.push(related);
      }
    }
  }

  // record.save() and destroyRecord() do not name their model, so any model reached may be saved or deleted.
  for (const model of Array.from(touched).sort()) {
    const file = modelFiles.get(model)!;
    for (const operation of ["updateRecord", "deleteRecord"] as const) {
      emit(model, operation, `${relative(file)} (save or delete, inferred)`, file, 1, true);
    }
  }
  return requests;
}
