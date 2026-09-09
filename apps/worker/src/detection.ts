import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import {
  parseIstanbulSummary,
  parseLcov,
  type AppInput,
  type CoverageFormat,
  type CoverageSummary
} from "@qa-buddy/shared";
import { TEST_RESULTS_FILE_NAME } from "./test-results.js";

interface PackageManifest {
  name?: unknown;
  scripts?: unknown;
  jest?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

interface PnpmWorkspaceDocument {
  packages?: unknown;
}

const JEST_WORKER_IDLE_MEMORY_LIMIT = "1GB";

export interface WorkspaceDetectionResult {
  apps: AppInput[];
  hasTurbo: boolean;
  workspaceCount: number;
}

export interface DiscoveredCoverage {
  coverage: CoverageSummary;
  coverageFormat: CoverageFormat;
  coveragePath: string;
}

function safeWorkspacePattern(pattern: string): boolean {
  const candidate = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return Boolean(
    candidate &&
      !candidate.startsWith("/") &&
      !candidate.includes("\\") &&
      !candidate.includes("\0") &&
      !candidate.split("/").includes("..")
  );
}

function declaredDependencyMajor(manifest: PackageManifest, dependencyName: string): number | null {
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    if (!dependencies || typeof dependencies !== "object") continue;
    const version = (dependencies as Record<string, unknown>)[dependencyName];
    if (typeof version !== "string") continue;
    const match = version.match(/^[\s~^<>=]*(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function testCommand(
  manifest: PackageManifest,
  scripts: Record<string, unknown>,
  testWorkerLimit: number
): string | null {
  const scriptName = ["test:coverage", "test:cov", "coverage", "test"].find(
    (candidate) => typeof scripts[candidate] === "string"
  );
  if (!scriptName) return null;

  const script = String(scripts[scriptName]).toLocaleLowerCase();
  const baseCommand = scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`;
  if (script.includes("vitest")) {
    const enablesCoverage = /(^|\s)--coverage(?=\s|$|=)/.test(script);
    const coverageArguments = `${enablesCoverage ? "" : " --coverage"} --coverage.reporter=json-summary --coverage.reportOnFailure`;
    const vitestMajor = declaredDependencyMajor(manifest, "vitest");
    const workerArguments =
      vitestMajor !== null && vitestMajor >= 4
        ? ` --maxWorkers=${testWorkerLimit}`
        : ` --maxWorkers=${testWorkerLimit} --minWorkers=1`;
    return `${baseCommand}${coverageArguments}${workerArguments} --reporter=default --reporter=json --outputFile.json=${TEST_RESULTS_FILE_NAME}`;
  }
  if (script.includes("jest")) {
    const enablesCoverage = /(^|\s)--coverage(?=\s|$|=)/.test(script);
    const coverageArguments = `${enablesCoverage ? "" : " --coverage"} --coverageReporters=json-summary`;
    const runsSerially = /(^|\s)(--runinband|-i)(?=\s|$)/.test(script);
    const workerArguments = runsSerially
      ? ""
      : ` --maxWorkers=${testWorkerLimit} --workerIdleMemoryLimit=${JEST_WORKER_IDLE_MEMORY_LIMIT}`;
    return `${baseCommand}${coverageArguments}${workerArguments} --coveragePathIgnorePatterns=/dist/ --json --outputFile=${TEST_RESULTS_FILE_NAME}`;
  }
  return scriptName === "test" ? `${baseCommand} --coverage` : baseCommand;
}

function uniqueName(name: string, directory: string, used: Set<string>): string {
  if (!used.has(name.toLocaleLowerCase())) {
    used.add(name.toLocaleLowerCase());
    return name;
  }
  const resolved = `${name} (${directory})`;
  used.add(resolved.toLocaleLowerCase());
  return resolved;
}

function configuredJestCoveragePath(manifest: PackageManifest, directory: string): string | null {
  if (!manifest.jest || typeof manifest.jest !== "object") return null;
  const coverageDirectory = (manifest.jest as { coverageDirectory?: unknown }).coverageDirectory;
  if (
    typeof coverageDirectory !== "string" ||
    !coverageDirectory ||
    coverageDirectory.includes("\\") ||
    coverageDirectory.includes("\0") ||
    path.posix.isAbsolute(coverageDirectory)
  ) {
    return null;
  }

  const resolvedDirectory = path.posix.normalize(path.posix.join(directory, coverageDirectory));
  if (resolvedDirectory === ".." || resolvedDirectory.startsWith("../")) return null;
  return path.posix.join(resolvedDirectory, "coverage-summary.json");
}

export async function detectPnpmWorkspaceApps(
  repositoryDirectory: string,
  testWorkerLimit = 2
): Promise<WorkspaceDetectionResult> {
  const workspacePath = path.join(repositoryDirectory, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) {
    throw new Error("Auto-detection requires pnpm-workspace.yaml at the repository root");
  }

  let document: PnpmWorkspaceDocument;
  try {
    document = parseYaml(readFileSync(workspacePath, "utf8")) as PnpmWorkspaceDocument;
  } catch {
    throw new Error("pnpm-workspace.yaml could not be parsed");
  }

  if (!Array.isArray(document.packages)) {
    throw new Error("pnpm-workspace.yaml must define a packages list");
  }
  const patterns = document.packages.filter(
    (value): value is string => typeof value === "string" && safeWorkspacePattern(value)
  );
  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml does not contain any safe workspace patterns");
  }

  const workspaceDirectories = (
    await fg(patterns, {
      cwd: repositoryDirectory,
      onlyDirectories: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**"]
    })
  )
    .map((directory) => directory.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((directory) => directory && !directory.startsWith("../"))
    .sort((left, right) => left.localeCompare(right));

  const manifests = workspaceDirectories.flatMap((directory) => {
    const manifestPath = path.join(repositoryDirectory, directory, "package.json");
    if (!existsSync(manifestPath)) return [];
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
      return [{ directory, manifest }];
    } catch {
      throw new Error(`Unable to parse ${directory}/package.json`);
    }
  });

  const appManifests = manifests.some(({ directory }) => directory === "apps" || directory.startsWith("apps/"))
    ? manifests.filter(({ directory }) => directory === "apps" || directory.startsWith("apps/"))
    : manifests;

  const usedNames = new Set<string>();
  const apps = appManifests.flatMap(({ directory, manifest }) => {
    const scripts =
      manifest.scripts && typeof manifest.scripts === "object"
        ? (manifest.scripts as Record<string, unknown>)
        : {};
    const command = testCommand(manifest, scripts, testWorkerLimit);
    if (!command) return [];

    const rawName = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : directory;
    return [
      {
        name: uniqueName(rawName, directory, usedNames),
        workingDirectory: directory,
        testCommand: command,
        coverageFormat: "istanbul-summary-json" as const,
        coveragePath:
          configuredJestCoveragePath(manifest, directory) ??
          path.posix.join(directory, "coverage/coverage-summary.json")
      }
    ];
  });

  if (apps.length === 0) {
    const location = appManifests.length ? "detected app workspaces" : "pnpm workspaces";
    throw new Error(
      `No coverage-capable test scripts were found in ${location}; add test:coverage, test:cov, coverage, or test to package.json`
    );
  }

  return {
    apps,
    hasTurbo: existsSync(path.join(repositoryDirectory, "turbo.json")),
    workspaceCount: manifests.length
  };
}

function coverageCandidates(
  workingDirectory: string,
  configuredCoveragePath?: string
): Array<{ path: string; format: CoverageFormat }> {
  const monorepoCoverageDirectory = path.posix.join("coverage", workingDirectory);
  const configuredCoverageDirectory = configuredCoveragePath
    ? path.posix.dirname(configuredCoveragePath)
    : null;
  return [
    ...(configuredCoveragePath
      ? [{ path: configuredCoveragePath, format: "istanbul-summary-json" as const }]
      : []),
    ...(configuredCoverageDirectory
      ? [{ path: path.posix.join(configuredCoverageDirectory, "lcov.info"), format: "lcov" as const }]
      : []),
    {
      path: path.posix.join(workingDirectory, "coverage/coverage-summary.json"),
      format: "istanbul-summary-json"
    },
    {
      path: path.posix.join(workingDirectory, "coverage-summary.json"),
      format: "istanbul-summary-json"
    },
    { path: path.posix.join(workingDirectory, "coverage/lcov.info"), format: "lcov" },
    { path: path.posix.join(workingDirectory, "lcov.info"), format: "lcov" },
    {
      path: path.posix.join(monorepoCoverageDirectory, "coverage-summary.json"),
      format: "istanbul-summary-json"
    },
    { path: path.posix.join(monorepoCoverageDirectory, "lcov.info"), format: "lcov" }
  ];
}

function containedReportPath(repositoryDirectory: string, relativePath: string): string | null {
  const repositoryRoot = path.resolve(repositoryDirectory);
  const reportPath = path.resolve(repositoryDirectory, relativePath);
  return reportPath.startsWith(`${repositoryRoot}${path.sep}`) ? reportPath : null;
}

export function clearAppReports(
  repositoryDirectory: string,
  workingDirectory: string,
  configuredCoveragePath?: string
): string[] {
  const relativePaths = [
    ...coverageCandidates(workingDirectory, configuredCoveragePath).map((candidate) => candidate.path),
    path.posix.join(workingDirectory, TEST_RESULTS_FILE_NAME)
  ];
  const removed: string[] = [];
  const seen = new Set<string>();

  for (const relativePath of relativePaths) {
    const reportPath = containedReportPath(repositoryDirectory, relativePath);
    if (!reportPath || seen.has(reportPath) || !existsSync(reportPath)) continue;
    seen.add(reportPath);
    if (lstatSync(reportPath).isDirectory()) continue;
    rmSync(reportPath, { force: true });
    removed.push(relativePath);
  }

  return removed;
}

export function discoverCoverageReport(
  repositoryDirectory: string,
  workingDirectory: string,
  configuredCoveragePath?: string
): DiscoveredCoverage {
  const candidates = coverageCandidates(workingDirectory, configuredCoveragePath);

  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    const candidateKey = `${candidate.format}:${candidate.path}`;
    if (seenCandidates.has(candidateKey)) continue;
    seenCandidates.add(candidateKey);
    const reportPath = containedReportPath(repositoryDirectory, candidate.path);
    if (!reportPath || !existsSync(reportPath)) continue;
    const contents = readFileSync(reportPath, "utf8");
    return {
      coverage:
        candidate.format === "lcov" ? parseLcov(contents) : parseIstanbulSummary(contents),
      coverageFormat: candidate.format,
      coveragePath: candidate.path
    };
  }

  throw new Error(
    `Coverage report was not found for ${workingDirectory}; expected coverage-summary.json or lcov.info in a configured or conventional coverage directory`
  );
}
