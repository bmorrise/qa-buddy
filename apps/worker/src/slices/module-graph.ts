import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { WorkspacePackage } from "./workspaces.js";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** Files that never count as application source, even when reachable. */
const NON_SOURCE_PATTERN =
  /(^|\/)(__tests__|__mocks__|__fixtures__|node_modules|dist|cypress)(\/|$)|\.(test|spec|stories|cy|d)\.[cm]?[jt]sx?$/;

export function isApplicationSource(repositoryRelativePath: string): boolean {
  return !NON_SOURCE_PATTERN.test(repositoryRelativePath);
}

export interface ParsedModule {
  /** Runtime module specifiers: static imports, re-exports, import() and require(). */
  specifiers: string[];
  /**
   * Names taken from each specifier. `*` marks a namespace import or star
   * re-export whose members could not be narrowed down.
   */
  importedNames: Map<string, Set<string>>;
}

function stringArgument(node: ts.CallExpression): string | null {
  const [first] = node.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** Extracts what a module imports at runtime. Type-only imports are ignored. */
export function parseModule(fileName: string, text: string): ParsedModule {
  const scriptKind = fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind);
  const specifiers: string[] = [];
  const importedNames = new Map<string, Set<string>>();
  const namespaceLocals = new Map<string, string>();

  const addNames = (specifier: string, names: string[]): void => {
    const existing = importedNames.get(specifier) ?? new Set<string>();
    for (const name of names) existing.add(name);
    importedNames.set(specifier, existing);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      specifiers.push(specifier);
      const names: string[] = [];
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          names.push((element.propertyName ?? element.name).text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceLocals.set(bindings.name.text, specifier);
      }
      addNames(specifier, names);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      !statement.isTypeOnly
    ) {
      const specifier = statement.moduleSpecifier.text;
      specifiers.push(specifier);
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        addNames(
          specifier,
          clause.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
        );
      } else {
        addNames(specifier, ["*"]);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = stringArgument(node);
        if (specifier) {
          specifiers.push(specifier);
          addNames(specifier, ["*"]);
        }
      }
    } else if (
      namespaceLocals.size > 0 &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaceLocals.has(node.expression.text)
    ) {
      addNames(namespaceLocals.get(node.expression.text)!, [node.name.text]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { specifiers: Array.from(new Set(specifiers)), importedNames };
}

interface PathAliases {
  /** Pattern such as `@app/*` mapped to absolute target patterns. */
  entries: Array<{ pattern: string; targets: string[] }>;
}

function readJsonWithComments(filePath: string): Record<string, unknown> | null {
  try {
    const result = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, "utf8"));
    return result.error ? null : (result.config as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Collects tsconfig `paths` for one project, following relative `extends` and
 * project `references` (Vite projects often keep aliases in tsconfig.app.json).
 * Package-based `extends` is skipped because nothing is installed.
 */
function readPathAliases(projectDirectory: string): PathAliases {
  const entries: PathAliases["entries"] = [];
  const seen = new Set<string>();

  const load = (configPath: string): void => {
    const resolved = path.resolve(configPath);
    if (seen.has(resolved) || !existsSync(resolved)) return;
    seen.add(resolved);
    const config = readJsonWithComments(resolved);
    if (!config) return;
    const configDirectory = path.dirname(resolved);

    const options = (config.compilerOptions ?? {}) as { paths?: Record<string, unknown>; baseUrl?: unknown };
    if (options.paths && typeof options.paths === "object") {
      const base =
        typeof options.baseUrl === "string" ? path.resolve(configDirectory, options.baseUrl) : configDirectory;
      for (const [pattern, targets] of Object.entries(options.paths)) {
        if (!Array.isArray(targets)) continue;
        entries.push({
          pattern,
          targets: targets.filter((target): target is string => typeof target === "string").map((target) => path.resolve(base, target))
        });
      }
    }

    const extendsValue = config.extends;
    for (const parent of Array.isArray(extendsValue) ? extendsValue : [extendsValue]) {
      if (typeof parent === "string" && parent.startsWith(".")) {
        load(path.resolve(configDirectory, parent.endsWith(".json") ? parent : `${parent}.json`));
      }
    }
    if (Array.isArray(config.references)) {
      for (const reference of config.references) {
        const referencePath = (reference as { path?: unknown })?.path;
        if (typeof referencePath !== "string") continue;
        const target = path.resolve(configDirectory, referencePath);
        load(target.endsWith(".json") ? target : path.join(target, "tsconfig.json"));
      }
    }
  };

  load(path.join(projectDirectory, "tsconfig.json"));
  // More specific patterns win, as TypeScript prefers the longest prefix.
  entries.sort((left, right) => right.pattern.length - left.pattern.length);
  return { entries };
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves a path without extension, a `.js` path written for TS ESM, or a directory index. */
export function resolveSourceFile(base: string): string | null {
  const extension = path.extname(base);
  if (CODE_EXTENSIONS.includes(extension) && isFile(base)) return base;
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const replacement of [".ts", ".tsx", ".mts", ".cts"]) {
      if (isFile(stem + replacement)) return stem + replacement;
    }
  }
  for (const candidate of CODE_EXTENSIONS) {
    if (isFile(base + candidate)) return base + candidate;
  }
  if (isDirectory(base)) {
    for (const candidate of CODE_EXTENSIONS) {
      const index = path.join(base, `index${candidate}`);
      if (isFile(index)) return index;
    }
  }
  return null;
}

/**
 * Resolves import specifiers to files inside the checkout without installing
 * anything: relative paths, tsconfig path aliases, the common Vite `@/` alias
 * and pnpm workspace packages. npm packages resolve to null.
 */
export class ModuleResolver {
  private readonly packagesByName: Array<WorkspacePackage & { name: string }>;
  private readonly aliasCache = new Map<string, PathAliases>();
  private readonly parseCache = new Map<string, ParsedModule>();

  constructor(
    private readonly repositoryDirectory: string,
    private readonly workspaces: WorkspacePackage[]
  ) {
    this.packagesByName = workspaces
      .filter((workspace): workspace is WorkspacePackage & { name: string } => workspace.name !== null)
      .sort((left, right) => right.name.length - left.name.length);
  }

  relative(absolutePath: string): string {
    return path.relative(this.repositoryDirectory, absolutePath).split(path.sep).join("/");
  }

  /** The workspace whose directory contains this file, preferring the deepest. */
  workspaceOf(absolutePath: string): WorkspacePackage | null {
    const relativePath = this.relative(absolutePath);
    let best: WorkspacePackage | null = null;
    for (const workspace of this.workspaces) {
      if (relativePath === workspace.directory || relativePath.startsWith(`${workspace.directory}/`)) {
        if (!best || workspace.directory.length > best.directory.length) best = workspace;
      }
    }
    return best;
  }

  /** The workspace package a bare specifier names, if any. */
  packageFor(specifier: string): (WorkspacePackage & { name: string }) | null {
    return (
      this.packagesByName.find(
        (workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`)
      ) ?? null
    );
  }

  parse(absolutePath: string): ParsedModule {
    const cached = this.parseCache.get(absolutePath);
    if (cached) return cached;
    let parsed: ParsedModule;
    try {
      parsed = parseModule(absolutePath, readFileSync(absolutePath, "utf8"));
    } catch {
      parsed = { specifiers: [], importedNames: new Map() };
    }
    this.parseCache.set(absolutePath, parsed);
    return parsed;
  }

  private aliasesFor(workspace: WorkspacePackage): PathAliases {
    const cached = this.aliasCache.get(workspace.directory);
    if (cached) return cached;
    const aliases = readPathAliases(path.join(this.repositoryDirectory, workspace.directory));
    this.aliasCache.set(workspace.directory, aliases);
    return aliases;
  }

  private insideCheckout(absolutePath: string): boolean {
    const root = path.resolve(this.repositoryDirectory);
    return absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`);
  }

  private resolvePackage(workspace: WorkspacePackage & { name: string }, specifier: string): string | null {
    const packageDirectory = path.join(this.repositoryDirectory, workspace.directory);
    const subpath = specifier === workspace.name ? "." : `./${specifier.slice(workspace.name.length + 1)}`;
    const candidates: string[] = [];

    const pickTarget = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (value && typeof value === "object") {
        const conditions = value as Record<string, unknown>;
        return ["source", "development", "import", "types", "default", "require"].flatMap((key) => pickTarget(conditions[key]));
      }
      return [];
    };

    const exportsField = workspace.manifest.exports;
    if (typeof exportsField === "string" && subpath === ".") {
      candidates.push(exportsField);
    } else if (exportsField && typeof exportsField === "object") {
      const map = exportsField as Record<string, unknown>;
      if (map[subpath] !== undefined) {
        candidates.push(...pickTarget(map[subpath]));
      } else {
        for (const [key, value] of Object.entries(map)) {
          if (!key.includes("*")) continue;
          const [prefix, suffix] = key.split("*") as [string, string];
          if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
            const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
            candidates.push(...pickTarget(value).map((target) => target.replace("*", matched)));
          }
        }
      }
      if (subpath === "." && !Object.keys(map).some((key) => key.startsWith("."))) {
        candidates.push(...pickTarget(map));
      }
    }
    if (subpath === ".") {
      for (const field of ["source", "module", "main", "types", "typings"]) {
        const value = workspace.manifest[field];
        if (typeof value === "string") candidates.push(value);
      }
      candidates.push("src/index", "index");
    } else {
      candidates.push(subpath, path.posix.join("src", subpath));
    }

    for (const candidate of candidates) {
      const absolute = path.resolve(packageDirectory, candidate);
      const direct = resolveSourceFile(absolute);
      if (direct && !direct.endsWith(".d.ts")) return direct;
      // Built output is not present in a fresh checkout; map it back to source.
      const relativeToPackage = path.relative(packageDirectory, absolute).split(path.sep);
      if (["dist", "build", "lib"].includes(relativeToPackage[0] ?? "")) {
        const sourceBase = path.join(packageDirectory, "src", ...relativeToPackage.slice(1)).replace(/\.d\.ts$|\.[cm]?js$/, "");
        const mapped = resolveSourceFile(sourceBase);
        if (mapped) return mapped;
      }
      if (direct) {
        const declarationSource = resolveSourceFile(direct.replace(/\.d\.ts$/, ""));
        if (declarationSource && !declarationSource.endsWith(".d.ts")) return declarationSource;
      }
    }
    return null;
  }

  resolve(fromFile: string, rawSpecifier: string): string | null {
    const specifier = rawSpecifier.replace(/[?#].*$/, "");
    if (!specifier || specifier.startsWith("node:")) return null;

    let resolved: string | null = null;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? path.join(this.repositoryDirectory, specifier)
        : path.resolve(path.dirname(fromFile), specifier);
      resolved = resolveSourceFile(base);
    } else {
      const workspace = this.workspaceOf(fromFile);
      if (workspace) {
        for (const entry of this.aliasesFor(workspace).entries) {
          const star = entry.pattern.indexOf("*");
          let matched: string | null = null;
          if (star === -1) {
            if (specifier === entry.pattern) matched = "";
          } else {
            const prefix = entry.pattern.slice(0, star);
            const suffix = entry.pattern.slice(star + 1);
            if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
              matched = specifier.slice(prefix.length, specifier.length - suffix.length);
            }
          }
          if (matched === null) continue;
          for (const target of entry.targets) {
            resolved = resolveSourceFile(target.replace("*", matched));
            if (resolved) break;
          }
          if (resolved) break;
        }
        if (!resolved && specifier.startsWith("@/")) {
          resolved = resolveSourceFile(path.join(this.repositoryDirectory, workspace.directory, "src", specifier.slice(2)));
        }
      }
      if (!resolved) {
        const target = this.packageFor(specifier);
        if (target) resolved = this.resolvePackage(target, specifier);
      }
    }

    return resolved && this.insideCheckout(resolved) ? resolved : null;
  }
}
