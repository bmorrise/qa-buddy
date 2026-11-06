import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findExpressEndpoints } from "./express-routes.js";
import { isApplicationSource, listCodeFiles, ModuleResolver, readSourceText, resolveSourceFile, siblingModules } from "./module-graph.js";
import { buildClientNameIndex, candidateOperationIds, findNestEndpoints, type NestEndpoint } from "./nest-endpoints.js";
import { assignOperationIds, orderEndpoints } from "./nest-modules.js";
import { findEmberDataRequests } from "./ember-data.js";
import { type ClientContext, createsClient, matchCall, type UrlCall, UrlCallScanner } from "./url-calls.js";
import { listWorkspacePackages, type WorkspacePackage } from "./workspaces.js";

export interface SliceTarget {
  /** Slice name shown in the UI, for example `idinspect`. */
  name: string;
  /** Frontend workspace directory, for example `apps/idinspect`. */
  frontendDirectory: string;
}

/** One backend a slice can reach, and the ways frontends call it. */
export interface BackendOptions {
  /** Backend workspace, for example `apps/idp-api-service`. */
  directory: string;
  framework: "nestjs" | "express";
  /** Generated client package frontends call through (NestJS only). */
  clientPackage?: string;
  /** NestJS root module relative to the workspace. Defaults to `src/app.module.ts`. */
  rootModule?: string;
  /** Express entry file relative to the workspace. Defaults to `app.js`. */
  entryFile?: string;
  /** Names the backend's base URL goes by in frontend code, for matching hand-written requests. */
  baseUrlNames?: string[];
}

export interface SliceEndpoint {
  backendDirectory: string;
  httpMethod: string;
  path: string;
  controller: string;
  methodKey: string;
  file: string;
  /** Client exports, or `file:line` request sites, that reach this endpoint. */
  clientNames: string[];
  /** True when the call could also mean another endpoint. */
  ambiguous: boolean;
}

export interface UnmatchedCall {
  backendDirectory: string;
  /** Repository-relative file and line of the request. */
  site: string;
  method: string | null;
  path: string;
}

export interface SliceBackendAnalysis {
  directory: string;
  endpointCount: number;
  /** Repository-relative backend files the endpoints depend on, sorted. */
  files: string[];
}

export interface SliceAnalysis {
  name: string;
  frontendDirectory: string;
  entryFiles: string[];
  /** Frontend source files reachable from the entry points, including workspace libraries. */
  frontendFileCount: number;
  endpoints: SliceEndpoint[];
  backends: SliceBackendAnalysis[];
  /** Every backend file across backends, sorted. */
  backendFiles: string[];
  /** Client exports used by the frontend that matched no endpoint. */
  unmatchedClientNames: string[];
  /** Hand-written requests to a configured backend that matched no route. */
  unmatchedCalls: UnmatchedCall[];
}

export interface SliceAnalysisResult {
  slices: SliceAnalysis[];
  /** Frontends that could not be sliced, with the reason. */
  skipped: Array<{ frontendDirectory: string; reason: string }>;
}

function dependsOn(workspace: WorkspacePackage, packageName: string): boolean {
  return ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
    const dependencies = workspace.manifest[field];
    return Boolean(dependencies && typeof dependencies === "object" && packageName in (dependencies as object));
  });
}

/**
 * Frontends worth slicing when none are configured: every `apps/*` workspace
 * that depends on one of the client packages. Libraries are traced through the
 * apps that import them rather than sliced on their own.
 */
export function discoverFrontends(
  workspaces: WorkspacePackage[],
  clientPackages: string[],
  backendDirectories: string[]
): SliceTarget[] {
  return workspaces
    .filter((workspace) => workspace.directory.startsWith("apps/") && !backendDirectories.includes(workspace.directory))
    .filter((workspace) => clientPackages.some((name) => workspace.name !== name && dependsOn(workspace, name)))
    .map((workspace) => ({ name: path.posix.basename(workspace.directory), frontendDirectory: workspace.directory }));
}

/** Entry modules for a frontend workspace: Vite's index.html script, then common names. */
export function findEntryFiles(repositoryDirectory: string, workspace: WorkspacePackage): string[] {
  const workspaceDirectory = path.join(repositoryDirectory, workspace.directory);
  const entries: string[] = [];
  const indexHtml = path.join(workspaceDirectory, "index.html");
  if (existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, "utf8");
    for (const match of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
      const source = match[1]!;
      if (/^(https?:)?\/\//.test(source)) continue;
      const resolved = resolveSourceFile(path.join(workspaceDirectory, source.replace(/^\//, "")));
      if (resolved) entries.push(resolved);
    }
  }
  if (entries.length === 0) {
    for (const candidate of ["src/main", "src/index", "app/app", "src/app", "index"]) {
      const resolved = resolveSourceFile(path.join(workspaceDirectory, candidate));
      if (resolved) {
        entries.push(resolved);
        break;
      }
    }
  }
  return entries;
}

/**
 * Ember apps load every module under `app/` by naming convention (routes,
 * services, components, adapters), not by import, so all of it is reachable.
 */
export function isEmberApp(workspace: WorkspacePackage): boolean {
  return dependsOn(workspace, "ember-source");
}

export function conventionLoadedFiles(repositoryDirectory: string, workspace: WorkspacePackage): string[] {
  return isEmberApp(workspace) ? listCodeFiles(path.join(repositoryDirectory, workspace.directory, "app")) : [];
}

/** Ember service properties a file injects, mapped to service names: `@service declare fetch` or `@service('fetch') declare http`. */
export function injectedServices(text: string): Map<string, string> {
  const services = new Map<string, string>();
  const pattern = /@service(?:\(\s*['"]([^'"]+)['"]\s*\))?\s+(?:declare\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(pattern)) {
    const property = match[2]!;
    services.set(property, match[1] ?? property.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase());
  }
  return services;
}

/** The Ember service a file defines, from its `app/services/` path, or null. */
function serviceName(repositoryRelativePath: string): string | null {
  const match = /(?:^|\/)app\/services\/(.+)\.(?:[cm]?[jt]s|g[jt]s)$/.exec(repositoryRelativePath);
  return match ? match[1]! : null;
}

const isPackage = (specifier: string, name: string): boolean => specifier === name || specifier.startsWith(`${name}/`);

/**
 * Walks runtime imports from the entry points, following workspace libraries
 * but stopping at client packages, and collects every name imported from each.
 */
function traceFrontend(
  resolver: ModuleResolver,
  entries: string[],
  clientPackages: string[]
): { files: Set<string>; clientNames: Map<string, Set<string>> } {
  const files = new Set<string>();
  const clientNames = new Map(clientPackages.map((name) => [name, new Set<string>()] as const));
  const queue = [...entries];

  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    if (!isApplicationSource(resolver.relative(file))) continue;
    files.add(file);
    const parsed = resolver.parse(file);
    for (const specifier of parsed.specifiers) {
      const clientPackage = clientPackages.find((name) => isPackage(specifier, name));
      if (clientPackage) {
        for (const name of parsed.importedNames.get(specifier) ?? []) clientNames.get(clientPackage)!.add(name);
        continue;
      }
      const target = resolver.resolve(file, specifier);
      if (target && !files.has(target)) queue.push(target);
    }
  }
  return { files, clientNames };
}

/** Transitive runtime imports of the starting files that stay inside one workspace. */
function traceBackend(resolver: ModuleResolver, starts: string[], backendDirectory: string): Set<string> {
  const inside = (relativePath: string): boolean => relativePath.startsWith(`${backendDirectory}/`);
  const files = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    const relativePath = resolver.relative(file);
    if (!inside(relativePath) || !isApplicationSource(relativePath)) continue;
    files.add(file);
    const parsed = resolver.parse(file);
    for (const specifier of parsed.specifiers) {
      const target = resolver.resolve(file, specifier);
      if (target && !files.has(target)) queue.push(target);
    }
    if (parsed.loadsSiblings) {
      for (const sibling of siblingModules(file)) if (!files.has(sibling)) queue.push(sibling);
    }
  }
  return files;
}

/** Code-point order, so output is identical on every machine and locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Everything about one backend that does not depend on the frontend. */
interface PreparedBackend {
  options: BackendOptions;
  routes: NestEndpoint[];
  clientIndex: Map<string, NestEndpoint[]> | null;
  scanner: UrlCallScanner | null;
}

async function prepareBackend(
  repositoryDirectory: string,
  options: BackendOptions,
  resolver: ModuleResolver
): Promise<PreparedBackend> {
  const { directory } = options;
  if (options.framework === "express") {
    const entry = options.entryFile ?? "app.js";
    if (!existsSync(path.join(repositoryDirectory, directory, entry))) {
      throw new Error(`Express entry file ${path.posix.join(directory, entry)} was not found`);
    }
    const routes = findExpressEndpoints(repositoryDirectory, directory, entry, resolver);
    if (routes.length === 0) throw new Error(`No Express routes were found from ${path.posix.join(directory, entry)}`);
    return {
      options,
      routes,
      clientIndex: null,
      scanner: options.baseUrlNames?.length ? new UrlCallScanner(options.baseUrlNames) : null
    };
  }

  const routes = await findNestEndpoints(repositoryDirectory, directory);
  if (routes.length === 0) throw new Error(`No NestJS controller endpoints were found in ${directory}`);
  let clientIndex: Map<string, NestEndpoint[]> | null = null;
  if (options.clientPackage) {
    const rootModule = path.posix.join(directory, options.rootModule ?? "src/app.module.ts");
    if (!existsSync(path.join(repositoryDirectory, rootModule))) {
      throw new Error(`Root module ${rootModule} was not found`);
    }
    const { ordered, unreached } = orderEndpoints(repositoryDirectory, rootModule, routes, resolver);
    const operationIds = new Map<NestEndpoint, string[]>();
    for (const [endpoint, operationId] of assignOperationIds(ordered)) operationIds.set(endpoint, [operationId]);
    for (const endpoint of unreached) operationIds.set(endpoint, candidateOperationIds(endpoint));
    clientIndex = buildClientNameIndex(operationIds);
  }
  return {
    options,
    routes,
    clientIndex,
    scanner: options.baseUrlNames?.length ? new UrlCallScanner(options.baseUrlNames) : null
  };
}

/**
 * Traces each target frontend to the backend files it depends on, across every
 * configured backend. Pass null targets to discover them. Problems with a
 * backend fail the whole analysis; a frontend that cannot be traced is skipped
 * with a reason.
 */
export async function analyzeSlices(
  repositoryDirectory: string,
  requestedTargets: SliceTarget[] | null,
  backends: BackendOptions[]
): Promise<SliceAnalysisResult> {
  if (backends.length === 0) throw new Error("Configure at least one backend to slice");
  const workspaces = await listWorkspacePackages(repositoryDirectory);
  for (const backend of backends) {
    if (!workspaces.some((workspace) => workspace.directory === backend.directory)) {
      throw new Error(`${backend.directory} is not a pnpm workspace in this repository`);
    }
  }
  const clientPackages = backends.flatMap((backend) => (backend.clientPackage ? [backend.clientPackage] : []));
  const targets =
    requestedTargets ?? discoverFrontends(workspaces, clientPackages, backends.map((backend) => backend.directory));
  const resolver = new ModuleResolver(repositoryDirectory, workspaces);
  const prepared: PreparedBackend[] = [];
  for (const backend of backends) prepared.push(await prepareBackend(repositoryDirectory, backend, resolver));

  const texts = new Map<string, string>();
  const readText = (file: string): string => {
    if (!texts.has(file)) {
      try {
        texts.set(file, readSourceText(file));
      } catch {
        texts.set(file, "");
      }
    }
    return texts.get(file)!;
  };

  const slices: SliceAnalysis[] = [];
  const skipped: SliceAnalysisResult["skipped"] = [];
  for (const target of targets) {
    const workspace = workspaces.find((candidate) => candidate.directory === target.frontendDirectory);
    if (!workspace) {
      skipped.push({ frontendDirectory: target.frontendDirectory, reason: "not a pnpm workspace in this repository" });
      continue;
    }
    const entryFiles = findEntryFiles(repositoryDirectory, workspace);
    if (entryFiles.length === 0) {
      skipped.push({ frontendDirectory: target.frontendDirectory, reason: "no entry point (index.html script or src/main) was found" });
      continue;
    }
    const frontend = traceFrontend(
      resolver,
      [...entryFiles, ...conventionLoadedFiles(repositoryDirectory, workspace)],
      clientPackages
    );
    const frontendFiles = Array.from(frontend.files).sort(compareText);

    const matched = new Map<NestEndpoint, { backend: string; names: Set<string>; ambiguous: boolean }>();
    const add = (backend: string, endpoint: NestEndpoint, name: string, ambiguous: boolean): void => {
      const entry = matched.get(endpoint) ?? { backend, names: new Set<string>(), ambiguous: false };
      entry.names.add(name);
      entry.ambiguous ||= ambiguous;
      matched.set(endpoint, entry);
    };
    const unmatchedClientNames: string[] = [];
    const unmatchedCalls: UnmatchedCall[] = [];
    const seenUnmatched = new Set<string>();
    /** Adds the routes a request reaches; inferred requests that reach none are dropped, not reported. */
    const matchRequest = (backend: PreparedBackend, call: UrlCall, site: string, inferred: boolean): void => {
      const directory = backend.options.directory;
      const routes = matchCall(call, backend.routes);
      if (routes.length === 0) {
        const key = `${directory} ${call.method ?? "*"} ${call.path} ${site}`;
        if (!inferred && !seenUnmatched.has(key)) {
          seenUnmatched.add(key);
          unmatchedCalls.push({ backendDirectory: directory, site, method: call.method, path: call.path });
        }
        return;
      }
      for (const route of routes) add(directory, route, site, routes.length > 1);
    };
    const emberRequests = isEmberApp(workspace)
      ? findEmberDataRequests(
          path.join(repositoryDirectory, workspace.directory, "app"),
          frontendFiles,
          readText,
          (file) => resolver.relative(file),
          prepared.flatMap((backend) => backend.options.baseUrlNames ?? [])
        )
      : [];

    for (const backend of prepared) {
      const { directory, clientPackage } = backend.options;
      if (backend.clientIndex && clientPackage) {
        for (const name of frontend.clientNames.get(clientPackage) ?? []) {
          const candidates = backend.clientIndex.get(name);
          if (!candidates) {
            unmatchedClientNames.push(name);
            continue;
          }
          for (const endpoint of candidates) add(directory, endpoint, name, candidates.length > 1);
        }
      }
      if (backend.scanner) {
        const scanner = backend.scanner;
        const others = prepared.filter((other) => other !== backend && other.scanner).map((other) => other.scanner!);
        const clientModules = new Set(frontendFiles.filter((file) => createsClient(readText(file))));
        const wrappers = new Map<string, Set<string>>();
        const wrappersByService = new Map<string, Set<string>>();
        for (const file of frontendFiles) {
          const names = scanner.wrapperFunctions(file, readText(file));
          if (names.size === 0) continue;
          wrappers.set(file, names);
          const service = serviceName(resolver.relative(file));
          if (service) wrappersByService.set(service, names);
        }
        for (const file of frontendFiles) {
          const context: ClientContext = { importsClient: false, wrapperReceivers: new Map(), wrapperFunctions: new Set() };
          const parsed = resolver.parse(file);
          for (const specifier of parsed.specifiers) {
            const resolved = resolver.resolve(file, specifier);
            if (resolved === null) continue;
            // A shared axios client counts when it defaults to this backend and the file does not
            // point it elsewhere (`super(getToken, OTHER_HOST)`), or when the file names only this backend.
            if (clientModules.has(resolved)) {
              const text = readText(file);
              const ownBase = scanner.mentions(text);
              const otherBase = others.some((other) => other.mentions(text));
              const defaultsHere = scanner.mentions(readText(resolved));
              if ((defaultsHere && (ownBase || !otherBase)) || (ownBase && !otherBase)) context.importsClient = true;
            }
            const helpers = wrappers.get(resolved);
            if (helpers) {
              for (const name of parsed.importedNames.get(specifier) ?? []) if (helpers.has(name)) context.wrapperFunctions.add(name);
            }
          }
          if (wrappersByService.size) {
            for (const [property, service] of injectedServices(readText(file))) {
              const helpers = wrappersByService.get(service);
              if (helpers) context.wrapperReceivers.set(property, helpers);
            }
          }
          for (const call of scanner.scan(file, readText(file), context)) {
            matchRequest(backend, call, `${resolver.relative(call.file)}:${call.line}`, false);
          }
        }
      }
      for (const request of emberRequests) {
        if (backend.options.baseUrlNames?.includes(request.baseName)) matchRequest(backend, request.call, request.site, request.inferred);
      }
    }

    const backendAnalyses: SliceBackendAnalysis[] = [];
    const allFiles = new Set<string>();
    for (const backend of prepared) {
      const directory = backend.options.directory;
      const endpoints = Array.from(matched.entries()).filter(([, entry]) => entry.backend === directory);
      const handlerFiles = Array.from(new Set(endpoints.map(([endpoint]) => endpoint.file)));
      const files = Array.from(
        traceBackend(resolver, handlerFiles.map((file) => path.join(repositoryDirectory, file)), directory),
        (file) => resolver.relative(file)
      ).sort(compareText);
      for (const file of files) allFiles.add(file);
      backendAnalyses.push({ directory, endpointCount: endpoints.length, files });
    }

    slices.push({
      name: target.name,
      frontendDirectory: target.frontendDirectory,
      entryFiles: entryFiles.map((file) => resolver.relative(file)),
      frontendFileCount: frontend.files.size,
      endpoints: Array.from(matched.entries())
        .map(([endpoint, entry]) => ({
          backendDirectory: entry.backend,
          httpMethod: endpoint.httpMethod,
          path: endpoint.path,
          controller: endpoint.controller,
          methodKey: endpoint.methodKey,
          file: endpoint.file,
          clientNames: Array.from(entry.names).sort(compareText),
          ambiguous: entry.ambiguous
        }))
        .sort(
          (left, right) =>
            compareText(left.backendDirectory, right.backendDirectory) ||
            compareText(left.path, right.path) ||
            compareText(left.httpMethod, right.httpMethod)
        ),
      backends: backendAnalyses,
      backendFiles: Array.from(allFiles).sort(compareText),
      unmatchedClientNames: unmatchedClientNames.sort(compareText),
      unmatchedCalls: unmatchedCalls.sort((left, right) => compareText(left.site, right.site))
    });
  }
  return { slices, skipped };
}
