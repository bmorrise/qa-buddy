import ts from "typescript";
import type { NestEndpoint } from "./nest-endpoints.js";

/** One path segment of a call or route: literal text, a parameter, or anything else. */
type Segment = { kind: "static"; value: string } | { kind: "param"; optional?: boolean } | { kind: "dynamic" } | { kind: "rest" };

export interface UrlCall {
  /** Absolute path of the frontend file that makes the call. */
  file: string;
  line: number;
  /** Lowercase HTTP verb when it can be read from the call, otherwise null. */
  method: string | null;
  /** The path as written, with `{}` for interpolated values, for example `/companies/{}`. */
  path: string;
  segments: Segment[];
}

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/**
 * How a file can reach a backend besides spelling out its base URL.
 */
export interface ClientContext {
  /** The file imports an axios instance created with this backend's base, so `client.get('/path')` counts. */
  importsClient: boolean;
  /**
   * Request helpers that put this backend's base in front of a relative path,
   * keyed by the local name the file reaches them through (an injected Ember
   * service property such as `fetch`, or an imported module), with the helper
   * method names. `this.fetch.post('users')` counts when `fetch` maps to a set
   * holding `post`.
   */
  wrapperReceivers: Map<string, Set<string>>;
  /** Helper functions imported by name that prefix this backend's base. */
  wrapperFunctions: Set<string>;
}

/** Whether a module creates an axios instance with a `baseURL`, for whichever backend. */
export function createsClient(text: string): boolean {
  return /\.create\(\s*\{[^}]*baseURL/.test(text);
}

export const NO_CLIENT: ClientContext = { importsClient: false, wrapperReceivers: new Map(), wrapperFunctions: new Set() };

/** A variable declaration together with the block it is visible in. */
interface Declaration {
  scope: ts.Node;
  start: number;
  kind: "alias" | "url";
  tokens: string;
  node: ts.Node;
}

/** The block, function body, or file a declaration is visible in. */
function declarationScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isCaseClause(current) && !ts.isDefaultClause(current)) {
    if (ts.isArrowFunction(current) || ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current)) return current;
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

/** Names of the functions and methods in a file that take a parameter. */
function functionLikes(source: ts.SourceFile): Array<{ name: string; params: string[]; body: ts.Node }> {
  const found: Array<{ name: string; params: string[]; body: ts.Node }> = [];
  const visit = (node: ts.Node): void => {
    let name: string | null = null;
    let fn: ts.SignatureDeclaration | null = null;
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.body) {
      name = node.name.text;
      fn = node;
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
      fn = node.initializer;
    }
    if (name && fn && "body" in fn && fn.body) {
      const params = fn.parameters.flatMap((parameter) => (ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
      if (params.length) found.push({ name, params, body: fn.body as ts.Node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
const PARAM = "\u0000";

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return ts.ScriptKind.TSX;
  return /\.([cm]?js|gjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Finds requests a frontend makes to one backend, identified by the names its
 * base URL goes by (`VITE_AUTH_API_HOST`, `apiHost`, ...). Recognises base URL
 * templates and concatenation, local aliases of the base, URLs held in
 * variables, and axios instances created with that base.
 */
export class UrlCallScanner {
  constructor(private readonly baseNames: string[]) {}

  private isBaseReference(node: ts.Expression): boolean {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) return this.baseNames.includes(expression.text);
    return ts.isPropertyAccessExpression(expression) && this.baseNames.includes(expression.name.text);
  }

  /**
   * Functions and methods in a module that put this backend's base URL in
   * front of their first argument, directly (`${env.apiHost}${url}`) or by
   * passing it on to another such function (`post(url) { return this.request(url) }`).
   */
  wrapperFunctions(file: string, text: string): Set<string> {
    const wrappers = new Set<string>();
    if (!this.baseNames.some((name) => text.includes(name))) return wrappers;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const candidates = functionLikes(source);
    const prefixesDirectly = (body: ts.Node, params: string[]): boolean => {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isTemplateExpression(node) && node.head.text === "" && node.templateSpans.length === 2) {
          const [base, rest] = node.templateSpans as unknown as [ts.TemplateSpan, ts.TemplateSpan];
          const restExpression = unwrap(rest.expression);
          if (
            base.literal.text === "" &&
            rest.literal.text === "" &&
            this.isBaseReference(base.expression) &&
            ts.isIdentifier(restExpression) &&
            params.includes(restExpression.text)
          ) {
            found = true;
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
      return found;
    };
    const passesOn = (body: ts.Node, firstParam: string): boolean => {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isCallExpression(node) && node.arguments[0]) {
          const argument = unwrap(node.arguments[0]);
          const callee = node.expression;
          const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword ? callee.name.text : null;
          if (calleeName && wrappers.has(calleeName) && ts.isIdentifier(argument) && argument.text === firstParam) {
            found = true;
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
      return found;
    };
    for (const candidate of candidates) if (prefixesDirectly(candidate.body, candidate.params)) wrappers.add(candidate.name);
    let grew = wrappers.size > 0;
    while (grew) {
      grew = false;
      for (const candidate of candidates) {
        if (!wrappers.has(candidate.name) && passesOn(candidate.body, candidate.params[0]!)) {
          wrappers.add(candidate.name);
          grew = true;
        }
      }
    }
    return wrappers;
  }

  /** Whether a module creates an axios instance whose `baseURL` is this backend. */
  providesClient(text: string): boolean {
    return createsClient(text) && this.mentions(text);
  }

  /** Whether the text names this backend's base URL anywhere. */
  mentions(text: string): boolean {
    return this.baseNames.some((name) => text.includes(name));
  }

  /**
   * @param context how the file can reach this backend through clients and
   *   request helpers, so calls with relative paths count.
   */
  scan(file: string, text: string, context: ClientContext = NO_CLIENT): UrlCall[] {
    const { importsClient } = context;
    const usesWrappers = context.wrapperReceivers.size > 0 || context.wrapperFunctions.size > 0;
    if (!importsClient && !usesWrappers && !this.baseNames.some((name) => text.includes(name))) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const declarations = new Map<string, Declaration[]>();
    const providesClient = this.providesClient(text);

    /** The declaration an identifier refers to: the innermost visible one declared before it. */
    const lookup = (identifier: ts.Identifier): Declaration | null => {
      const position = identifier.getStart(source);
      let best: Declaration | null = null;
      for (const declaration of declarations.get(identifier.text) ?? []) {
        const { scope } = declaration;
        if (position < scope.getStart(source) || position >= scope.getEnd() || declaration.start >= position) continue;
        if (!best || scope.getStart(source) > best.scope.getStart(source) || (scope === best.scope && declaration.start > best.start)) {
          best = declaration;
        }
      }
      return best;
    };
    const urlVariable = (node: ts.Expression): Declaration | null => {
      const expression = unwrap(node);
      if (!ts.isIdentifier(expression)) return null;
      const declaration = lookup(expression);
      return declaration?.kind === "url" ? declaration : null;
    };
    const calls: UrlCall[] = [];
    const consumed = new Set<ts.Node>();

    const mentionsBase = (node: ts.Expression): boolean => {
      const expression = unwrap(node);
      if (ts.isIdentifier(expression)) return lookup(expression)?.kind === "alias" || this.baseNames.includes(expression.text);
      if (ts.isPropertyAccessExpression(expression)) return this.baseNames.includes(expression.name.text);
      if (ts.isBinaryExpression(expression)) {
        const operator = expression.operatorToken.kind;
        if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
          return mentionsBase(expression.left) || mentionsBase(expression.right);
        }
      }
      if (ts.isTemplateExpression(expression) && expression.head.text === "" && expression.templateSpans.length === 1) {
        return expression.templateSpans[0]!.literal.text === "" && mentionsBase(expression.templateSpans[0]!.expression);
      }
      return false;
    };

    /** Path tokens after the base URL, with PARAM for each interpolation, or null if `node` is not based on it. */
    const urlTokens = (node: ts.Expression, allowRelative: boolean): string | null => {
      const expression = unwrap(node);
      const variable = urlVariable(expression);
      if (variable) return variable.tokens;
      if (ts.isTemplateExpression(expression)) {
        const [first, ...rest] = expression.templateSpans;
        if (expression.head.text === "" && first) {
          let prefix: string | null = null;
          if (mentionsBase(first.expression)) prefix = "";
          else prefix = urlVariable(first.expression)?.tokens ?? null;
          if (prefix !== null) {
            return prefix + first.literal.text + rest.map((span) => PARAM + span.literal.text).join("");
          }
        }
        if (allowRelative && expression.head.text.startsWith("/")) {
          return expression.head.text + expression.templateSpans.map((span) => PARAM + span.literal.text).join("");
        }
        return null;
      }
      if (allowRelative && ts.isStringLiteralLike(expression) && expression.text.startsWith("/")) return expression.text;
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const parts: ts.Expression[] = [];
        const flatten = (part: ts.Expression): void => {
          const inner = unwrap(part);
          if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            flatten(inner.left);
            flatten(inner.right);
          } else {
            parts.push(inner);
          }
        };
        flatten(expression);
        const [head, ...tail] = parts;
        if (!head) return null;
        const prefix = mentionsBase(head) ? "" : urlTokens(head, false);
        if (prefix === null) return null;
        return (
          prefix +
          tail
            .map((part) => {
              if (ts.isStringLiteralLike(part)) return part.text;
              if (ts.isTemplateExpression(part)) {
                return part.head.text + part.templateSpans.map((span) => PARAM + span.literal.text).join("");
              }
              return PARAM;
            })
            .join("")
        );
      }
      return null;
    };

    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const record = (node: ts.Node, tokens: string, method: string | null, allowRoot = false): void => {
      consumed.add(node);
      const call = buildUrlCall(file, lineOf(node), method, tokens, allowRoot);
      if (call) calls.push(call);
    };

    /** Method from `fetch(url, { method: 'PUT' })`, or null when the options do not say. */
    const optionsMethod = (call: ts.CallExpression): string | null => {
      const options = call.arguments[1] ? unwrap(call.arguments[1]) : undefined;
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "method" &&
            ts.isStringLiteralLike(property.initializer)
          ) {
            return property.initializer.text.toLowerCase();
          }
        }
      }
      return null;
    };

    // Pass 1: aliases of the base URL and URLs stored in variables, in source order, with their scope.
    const declare = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const add = (kind: Declaration["kind"], tokens: string): void => {
          const list = declarations.get((node.name as ts.Identifier).text) ?? [];
          list.push({ scope: declarationScope(node.parent), start: node.getStart(source), kind, tokens, node: node.initializer! });
          declarations.set((node.name as ts.Identifier).text, list);
        };
        if (mentionsBase(node.initializer)) {
          add("alias", "");
        } else {
          const tokens = urlTokens(node.initializer, false);
          if (tokens !== null) add("url", tokens);
        }
      }
      ts.forEachChild(node, declare);
    };
    declare(source);

    /** A relative path handed to a request helper: `'users'`, `` `/assets/${id}` ``, never a full URL. */
    const relativeTokens = (node: ts.Expression): string | null => {
      const expression = unwrap(node);
      let tokens: string | null = null;
      if (ts.isStringLiteralLike(expression)) tokens = expression.text;
      else if (ts.isTemplateExpression(expression) && expression.head.text !== "") {
        tokens = expression.head.text + expression.templateSpans.map((span) => PARAM + span.literal.text).join("");
      }
      if (tokens === null || /^([a-z][a-z0-9+.-]*:)?\/\//i.test(tokens)) return null;
      return tokens.startsWith("/") ? tokens : `/${tokens}`;
    };

    /** The helper method a call reaches through a wrapper, or null. */
    const wrapperCall = (callee: ts.Expression): string | null => {
      if (ts.isIdentifier(callee)) return context.wrapperFunctions.has(callee.text) ? callee.text : null;
      if (!ts.isPropertyAccessExpression(callee)) return null;
      const receiver = unwrap(callee.expression);
      const receiverName = ts.isIdentifier(receiver)
        ? receiver.text
        : ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword
          ? receiver.name.text
          : null;
      return receiverName && context.wrapperReceivers.get(receiverName)?.has(callee.name.text) ? callee.name.text : null;
    };

    const consume = (first: ts.Expression): void => {
      const variable = urlVariable(first);
      if (variable) consumed.add(variable.node);
    };

    // Pass 2: requests.
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[0]) {
        const callee = node.expression;
        const first = node.arguments[0];
        const isFetch = ts.isIdentifier(callee) && callee.text === "fetch";
        const verb = ts.isPropertyAccessExpression(callee) && VERBS.has(callee.name.text) ? callee.name.text : null;
        const helper = wrapperCall(callee);
        if (helper) {
          const tokens = mentionsBase(first) ? "" : (urlTokens(first, false) ?? relativeTokens(first));
          if (tokens !== null) {
            record(first, tokens, VERBS.has(helper) ? helper : optionsMethod(node), true);
            consume(first);
          }
        } else if (isFetch || verb) {
          // Relative paths only count on a client known to point at this backend,
          // never on the global axios, which resolves them against the page origin.
          const onGlobalAxios = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "axios";
          const relativeAllowed = Boolean(verb) && !onGlobalAxios && (importsClient || providesClient);
          const tokens = mentionsBase(first) ? "" : urlTokens(first, relativeAllowed);
          if (tokens !== null) {
            record(first, tokens, isFetch ? (optionsMethod(node) ?? "get") : verb, true);
            consume(first);
          }
        } else if (node.arguments[1]) {
          // Any other request helper that says its method: `this.fetch.raw(url, { method: 'POST' })`.
          const method = optionsMethod(node);
          const tokens = method ? (mentionsBase(first) ? "" : urlTokens(first, false)) : null;
          if (method && tokens !== null) {
            record(first, tokens, method, true);
            consume(first);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // Pass 3: URLs built but used some other way (window.location, wrappers): method unknown.
    const leftovers = (node: ts.Node): void => {
      if ((ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) && !consumed.has(node)) {
        const parent = node.parent;
        const nestedInUrl =
          parent && (ts.isTemplateSpan(parent) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken));
        const tokens = nestedInUrl ? null : urlTokens(node as ts.Expression, false);
        if (tokens !== null) {
          record(node, tokens, null);
          return;
        }
      }
      ts.forEachChild(node, leftovers);
    };
    leftovers(source);

    return calls;
  }
}

/**
 * A call from the path after a backend's base URL, with `\u0000` marking each
 * interpolated value. Returns null when the path names no route: the base plus
 * one opaque value (a request helper prefixing its argument), or the bare base
 * unless it is requested directly with a known method.
 */
export function buildUrlCall(file: string, line: number, method: string | null, tokens: string, allowRoot = true): UrlCall | null {
  const pathPart = tokens.split(/[?#]/)[0] ?? "";
  if (pathPart === PARAM || pathPart === `/${PARAM}`) return null;
  const segments: Segment[] = pathPart
    .split("/")
    .filter(Boolean)
    .map((segment): Segment => {
      if (segment === PARAM) return { kind: "param" };
      if (segment.includes(PARAM)) return { kind: "dynamic" };
      return { kind: "static", value: segment };
    });
  if (segments.length === 0 && (!allowRoot || method === null)) return null;
  return {
    file,
    line,
    method,
    path: `/${pathPart.split("/").filter(Boolean).join("/")}`.replaceAll(PARAM, "{}"),
    segments
  };
}

function routeSegments(routePath: string): Segment[] {
  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment): Segment => {
      if (segment.includes("*")) return { kind: "rest" };
      const param = /^\{[^}]+?(\?)?\}$/.exec(segment);
      if (param) return { kind: "param", optional: Boolean(param[1]) };
      if (segment.startsWith(":") || segment.includes("{")) return { kind: "dynamic" };
      return { kind: "static", value: segment };
    });
}

/** Static segments matched, or -1 when the call cannot reach the route. */
function matchScore(call: Segment[], route: Segment[]): number {
  const attempt = (callIndex: number, routeIndex: number): number => {
    if (routeIndex === route.length) return callIndex === call.length ? 0 : -1;
    const routeSegment = route[routeIndex]!;
    if (routeSegment.kind === "rest") return 0;
    if (routeSegment.kind === "param" && routeSegment.optional) {
      const skipped = attempt(callIndex, routeIndex + 1);
      const taken = callIndex < call.length ? attempt(callIndex + 1, routeIndex + 1) : -1;
      return Math.max(skipped, taken);
    }
    if (callIndex === call.length) return -1;
    const callSegment = call[callIndex]!;
    let gained: number;
    if (routeSegment.kind === "static") {
      if (callSegment.kind !== "static" || callSegment.value !== routeSegment.value) return -1;
      gained = 1;
    } else {
      // A route parameter accepts anything; an interpolated call value only fits a parameter.
      gained = 0;
    }
    const rest = attempt(callIndex + 1, routeIndex + 1);
    return rest === -1 ? -1 : rest + gained;
  };
  return attempt(0, 0);
}

/**
 * The routes a call can reach. The most specific matches win, so
 * `/assets/batch` beats `/assets/:id` for a literal `batch`. When the verb is
 * unknown, GET routes are preferred.
 */
export function matchCall(call: UrlCall, routes: NestEndpoint[]): NestEndpoint[] {
  let best = -1;
  let matches: NestEndpoint[] = [];
  for (const route of routes) {
    if (call.method && route.httpMethod !== call.method && route.httpMethod !== "all") continue;
    const score = matchScore(call.segments, routeSegments(route.path));
    if (score < 0) continue;
    if (score > best) {
      best = score;
      matches = [route];
    } else if (score === best) {
      matches.push(route);
    }
  }
  if (!call.method && matches.length > 1) {
    const gets = matches.filter((route) => route.httpMethod === "get");
    if (gets.length) return gets;
  }
  return matches;
}
