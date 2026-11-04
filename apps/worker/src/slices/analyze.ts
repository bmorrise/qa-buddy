import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isApplicationSource, ModuleResolver, resolveSourceFile } from "./module-graph.js";
import { buildClientNameIndex, candidateOperationIds, findNestEndpoints, type NestEndpoint } from "./nest-endpoints.js";
import { assignOperationIds, orderEndpoints } from "./nest-modules.js";
import { listWorkspacePackages, type WorkspacePackage } from "./workspaces.js";

export interface SliceTarget {
  /** Slice name shown in the UI, for example `idinspect`. */
  name: string;
  /** Frontend workspace directory, for example `apps/idinspect`. */
  frontendDirectory: string;
}

export interface SliceAnalysisOptions {
  /** NestJS backend workspace, for example `apps/idp-api-service`. */
  backendDirectory: string;
  /** Root module file relative to the backend workspace. Defaults to `src/app.module.ts`. */
  rootModule?: string;
  /** Generated client package the frontends call through. */
  clientPackage: string;
}

export interface SliceEndpoint {
  httpMethod: string;
  path: string;
  controller: string;
  methodKey: string;
  file: string;
  /** Client exports that resolved here. */
  clientNames: string[];
  /** True when the client name could also mean an endpoint in another controller. */
  ambiguous: boolean;
}

export interface SliceAnalysis {
  name: string;
  frontendDirectory: string;
  backendDirectory: string;
  entryFiles: string[];
  /** Frontend source files reachable from the entry points, including workspace libraries. */
  frontendFileCount: number;
  endpoints: SliceEndpoint[];
  /** Repository-relative backend files the endpoints depend on, sorted. */
  backendFiles: string[];
  /** Client exports used by the frontend that matched no endpoint. */
  unmatchedClientNames: string[];
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
 * that depends on the client package. Libraries are traced through the apps
 * that import them rather than sliced on their own.
 */
export function discoverFrontends(workspaces: WorkspacePackage[], clientPackage: string, backendDirectory: string): SliceTarget[] {
  return workspaces
    .filter((workspace) => workspace.directory.startsWith("apps/") && workspace.directory !== backendDirectory)
    .filter((workspace) => workspace.name !== clientPackage && dependsOn(workspace, clientPackage))
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
 * Walks runtime imports from the entry points, following workspace libraries
 * but stopping at the client package, and collects every name imported from it.
 */
function traceFrontend(
  resolver: ModuleResolver,
  entries: string[],
  clientPackage: string
): { files: Set<string>; clientNames: Set<string> } {
  const files = new Set<string>();
  const clientNames = new Set<string>();
  const queue = [...entries];

  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    if (!isApplicationSource(resolver.relative(file))) continue;
    files.add(file);
    const parsed = resolver.parse(file);
    for (const specifier of parsed.specifiers) {
      if (specifier === clientPackage || specifier.startsWith(`${clientPackage}/`)) {
        for (const name of parsed.importedNames.get(specifier) ?? []) clientNames.add(name);
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
    for (const specifier of resolver.parse(file).specifiers) {
      const target = resolver.resolve(file, specifier);
      if (target && !files.has(target)) queue.push(target);
    }
  }
  return files;
}

/** Code-point order, so output is identical on every machine and locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Traces each target frontend to the backend files it depends on. Pass null
 * targets to discover them. Problems with the backend fail the whole analysis;
 * a frontend that cannot be traced is skipped with a reason.
 */
export async function analyzeSlices(
  repositoryDirectory: string,
  requestedTargets: SliceTarget[] | null,
  options: SliceAnalysisOptions
): Promise<SliceAnalysisResult> {
  const workspaces = await listWorkspacePackages(repositoryDirectory);
  if (!workspaces.some((workspace) => workspace.directory === options.backendDirectory)) {
    throw new Error(`${options.backendDirectory} is not a pnpm workspace in this repository`);
  }
  const targets = requestedTargets ?? discoverFrontends(workspaces, options.clientPackage, options.backendDirectory);
  const resolver = new ModuleResolver(repositoryDirectory, workspaces);
  const endpoints = await findNestEndpoints(repositoryDirectory, options.backendDirectory);
  if (endpoints.length === 0) {
    throw new Error(`No NestJS controller endpoints were found in ${options.backendDirectory}`);
  }
  const rootModule = path.posix.join(options.backendDirectory, options.rootModule ?? "src/app.module.ts");
  if (!existsSync(path.join(repositoryDirectory, rootModule))) {
    throw new Error(`Root module ${rootModule} was not found`);
  }
  const { ordered, unreached } = orderEndpoints(repositoryDirectory, rootModule, endpoints, resolver);
  const operationIds = new Map<NestEndpoint, string[]>();
  for (const [endpoint, operationId] of assignOperationIds(ordered)) operationIds.set(endpoint, [operationId]);
  for (const endpoint of unreached) operationIds.set(endpoint, candidateOperationIds(endpoint));
  const clientIndex = buildClientNameIndex(operationIds);

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
    const frontend = traceFrontend(resolver, entryFiles, options.clientPackage);

    const matched = new Map<NestEndpoint, { names: Set<string>; ambiguous: boolean }>();
    const unmatched: string[] = [];
    for (const name of frontend.clientNames) {
      const candidates = clientIndex.get(name);
      if (!candidates) {
        unmatched.push(name);
        continue;
      }
      for (const endpoint of candidates) {
        const entry = matched.get(endpoint) ?? { names: new Set<string>(), ambiguous: false };
        entry.names.add(name);
        entry.ambiguous ||= candidates.length > 1;
        matched.set(endpoint, entry);
      }
    }

    const controllerFiles = Array.from(new Set(Array.from(matched.keys()).map((endpoint) => endpoint.file)));
    const backendFiles = traceBackend(
      resolver,
      controllerFiles.map((file) => path.join(repositoryDirectory, file)),
      options.backendDirectory
    );

    slices.push({
      name: target.name,
      frontendDirectory: target.frontendDirectory,
      backendDirectory: options.backendDirectory,
      entryFiles: entryFiles.map((file) => resolver.relative(file)),
      frontendFileCount: frontend.files.size,
      endpoints: Array.from(matched.entries())
        .map(([endpoint, entry]) => ({
          httpMethod: endpoint.httpMethod,
          path: endpoint.path,
          controller: endpoint.controller,
          methodKey: endpoint.methodKey,
          file: endpoint.file,
          clientNames: Array.from(entry.names).sort(),
          ambiguous: entry.ambiguous
        }))
        .sort((left, right) => compareText(left.path, right.path) || compareText(left.httpMethod, right.httpMethod)),
      backendFiles: Array.from(backendFiles, (file) => resolver.relative(file)).sort(),
      unmatchedClientNames: unmatched.sort()
    });
  }
  return { slices, skipped };
}
