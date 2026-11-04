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
const PARAM = "\u0000";

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return ts.ScriptKind.TSX;
  return file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
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

  /** Whether a module creates an axios instance whose `baseURL` is this backend. */
  providesClient(text: string): boolean {
    return /\.create\(\s*\{[^}]*baseURL/.test(text) && this.baseNames.some((name) => text.includes(name));
  }

  /**
   * @param importsClient true when the file imports a module that provides a
   *   client for this backend, so `client.get('/path')` style calls count.
   */
  scan(file: string, text: string, importsClient: boolean): UrlCall[] {
    if (!importsClient && !this.baseNames.some((name) => text.includes(name))) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const baseAliases = new Set<string>();
    const urlVariables = new Map<string, { tokens: string; node: ts.Node }>();
    const providesClient = this.providesClient(text);
    const calls: UrlCall[] = [];
    const consumed = new Set<ts.Node>();

    const mentionsBase = (node: ts.Expression): boolean => {
      const expression = unwrap(node);
      if (ts.isIdentifier(expression)) return baseAliases.has(expression.text) || this.baseNames.includes(expression.text);
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
      if (ts.isIdentifier(expression) && urlVariables.has(expression.text)) return urlVariables.get(expression.text)!.tokens;
      if (ts.isTemplateExpression(expression)) {
        const [first, ...rest] = expression.templateSpans;
        if (expression.head.text === "" && first) {
          let prefix: string | null = null;
          if (mentionsBase(first.expression)) prefix = "";
          else if (ts.isIdentifier(unwrap(first.expression)) && urlVariables.has((unwrap(first.expression) as ts.Identifier).text)) {
            prefix = urlVariables.get((unwrap(first.expression) as ts.Identifier).text)!.tokens;
          }
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

    const record = (node: ts.Node, tokens: string, method: string | null): void => {
      consumed.add(node);
      const pathPart = tokens.split(/[?#]/)[0] ?? "";
      const segments: Segment[] = pathPart
        .split("/")
        .filter(Boolean)
        .map((segment): Segment => {
          if (segment === PARAM) return { kind: "param" };
          if (segment.includes(PARAM)) return { kind: "dynamic" };
          return { kind: "static", value: segment };
        });
      // A URL that is the bare base, or the base plus one opaque value, names no route.
      if (segments.length === 0) return;
      calls.push({
        file,
        line: lineOf(node),
        method,
        path: `/${pathPart.split("/").filter(Boolean).join("/")}`.replaceAll(PARAM, "{}"),
        segments
      });
    };

    /** Method from `fetch(url, { method: 'PUT' })`, defaulting to GET. */
    const fetchMethod = (call: ts.CallExpression): string => {
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
      return "get";
    };

    // Pass 1: aliases of the base URL and URLs stored in variables, in source order.
    const declare = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (mentionsBase(node.initializer)) {
          baseAliases.add(node.name.text);
        } else {
          const tokens = urlTokens(node.initializer, false);
          if (tokens !== null) urlVariables.set(node.name.text, { tokens, node: node.initializer });
        }
      }
      ts.forEachChild(node, declare);
    };
    declare(source);

    // Pass 2: requests.
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[0]) {
        const callee = node.expression;
        const first = node.arguments[0];
        const isFetch = ts.isIdentifier(callee) && callee.text === "fetch";
        const verb = ts.isPropertyAccessExpression(callee) && VERBS.has(callee.name.text) ? callee.name.text : null;
        if (isFetch || verb) {
          // Relative paths only count on a client known to point at this backend,
          // never on the global axios, which resolves them against the page origin.
          const onGlobalAxios = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "axios";
          const relativeAllowed = Boolean(verb) && !onGlobalAxios && (importsClient || providesClient);
          const tokens = urlTokens(first, relativeAllowed);
          if (tokens !== null) {
            record(first, tokens, isFetch ? fetchMethod(node) : verb);
            const inner = unwrap(first);
            if (ts.isIdentifier(inner) && urlVariables.has(inner.text)) consumed.add(urlVariables.get(inner.text)!.node);
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
