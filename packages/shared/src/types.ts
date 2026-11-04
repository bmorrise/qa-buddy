export type CoverageFormat = "istanbul-summary-json" | "lcov";

export type RunStatus =
  | "queued"
  | "cloning"
  | "setup"
  | "building"
  | "testing"
  | "passed"
  | "failed"
  | "timed_out"
  | "interrupted";

export type AppRunStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export interface AppInput {
  name: string;
  workingDirectory: string;
  testCommand: string;
  coverageFormat: CoverageFormat;
  coveragePath: string;
}

export interface RepositoryInput {
  name: string;
  githubUrl: string;
  defaultRef: string;
  /**
   * Optional path to this repository's checkout on the host, relative to the
   * directory bind-mounted at QA_BUDDY_LOCAL_SOURCE_DIR. Enables runs against
   * the local working tree instead of a GitHub fetch.
   */
  localPath?: string;
  /**
   * Extra pnpm workspace directories to test alongside `apps/*` when
   * auto-detection is on, for example `libs/scout-ui`. Opt-in only.
   */
  additionalWorkspaces: string[];
  /**
   * Workspace directories auto-detection never tests, even when they have a
   * test script, for example `apps/user-crm-sync`.
   */
  excludedWorkspaces: string[];
  runnerImage: string;
  setupCommand?: string;
  buildCommand?: string;
  testWorkerLimit: number;
  timeoutMinutes: number;
  environmentAllowlist: string[];
  autoDetect: boolean;
  /**
   * Target coverage percentage drawn on every trend chart, for every metric
   * and group. Null when no goal is set.
   */
  coverageGoal?: number | null;
  apps: AppInput[];
}

export interface RunConfigurationSnapshot extends RepositoryInput {
  selectedApps: string[] | null;
}

export interface AppConfiguration extends AppInput {
  id: string;
  repositoryId: string;
  position: number;
}

export interface CoverageMetric {
  covered: number;
  total: number;
  percent: number | null;
}

export interface CoverageSummary {
  lines: CoverageMetric | null;
  statements: CoverageMetric | null;
  functions: CoverageMetric | null;
  branches: CoverageMetric | null;
}

export interface CoverageFileEntry {
  path: string;
  lines: CoverageMetric | null;
  statements: CoverageMetric | null;
  functions: CoverageMetric | null;
  branches: CoverageMetric | null;
}

export interface CoverageReport {
  summary: CoverageSummary;
  files: CoverageFileEntry[];
}

export type CoverageMetricName = "lines" | "statements" | "functions" | "branches";

export const coverageMetricNames: CoverageMetricName[] = [
  "lines",
  "statements",
  "functions",
  "branches"
];

/**
 * Per-app view of the most recent coverage worth analysing. Snapshots are
 * replaced in place rather than retained per run, and deliberately survive run
 * history pruning.
 */
export interface CoverageSnapshot {
  repositoryId: string;
  appName: string;
  runId: string | null;
  resolvedSha: string | null;
  coverageFormat: CoverageFormat;
  coveragePath: string | null;
  fileCount: number;
  capturedAt: string;
  summary: CoverageSummary;
}

/**
 * One app's coverage and test counts from one completed (passed or failed)
 * run. History rows are never pruned with run history, so trends outlive the
 * runs that produced them.
 */
export interface CoverageHistoryEntry {
  runId: string;
  appName: string;
  requestedRef: string;
  resolvedSha: string | null;
  useLocalWorkingTree: boolean;
  dirty: boolean;
  recordedAt: string;
  coverage: CoverageSummary;
  tests: { total: number; passed: number; failed: number } | null;
}

export interface CoverageFileQuery {
  appName?: string;
  /** Only files in this slice. */
  sliceName?: string;
  metric?: CoverageMetricName;
  maxPercent?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CoverageFileRow extends CoverageFileEntry {
  appName: string;
}

/** A coverage file row in an export, with the slices that include it. */
export interface CoverageExportRow extends CoverageFileRow {
  slices: string[];
}

export interface CoverageFilePage {
  files: CoverageFileRow[];
  total: number;
  limit: number;
  offset: number;
}

export type TestCaseStatus = "passed" | "failed" | "skipped" | "todo";

export interface TestCaseResult {
  name: string;
  fullName: string;
  ancestorTitles: string[];
  filePath: string | null;
  status: TestCaseStatus;
  durationMs: number | null;
  failureMessage: string | null;
}

export interface TestResults {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  testCases: TestCaseResult[];
}

export interface AppRun {
  id: string;
  runId: string;
  name: string;
  workingDirectory: string;
  testCommand: string;
  coverageFormat: CoverageFormat;
  coveragePath: string;
  position: number;
  status: AppRunStatus;
  exitCode: number | null;
  coverage: CoverageSummary | null;
  coverageError: string | null;
  testResults: TestResults | null;
  testResultsError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunSummary {
  id: string;
  repositoryId: string;
  requestedRef: string;
  resolvedSha: string | null;
  /** True when the source was archived from the local checkout rather than fetched. */
  useLocalWorkingTree: boolean;
  /** True when the local working tree had uncommitted changes at archive time. */
  dirty: boolean;
  /** True once a stop has been requested; the worker ends the run as interrupted. */
  cancelRequested: boolean;
  status: RunStatus;
  error: string | null;
  selectedApps: string[] | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  appRuns: AppRun[];
}

export interface RunDetail extends RunSummary {
  configurationSnapshot: RunConfigurationSnapshot;
}

export interface Repository {
  id: string;
  name: string;
  githubUrl: string;
  defaultRef: string;
  localPath?: string;
  /**
   * Extra pnpm workspace directories to test alongside `apps/*` when
   * auto-detection is on, for example `libs/scout-ui`. Opt-in only.
   */
  additionalWorkspaces: string[];
  /**
   * Workspace directories auto-detection never tests, even when they have a
   * test script, for example `apps/user-crm-sync`.
   */
  excludedWorkspaces: string[];
  runnerImage: string;
  setupCommand?: string;
  buildCommand?: string;
  testWorkerLimit: number;
  timeoutMinutes: number;
  environmentAllowlist: string[];
  autoDetect: boolean;
  coverageGoal: number | null;
  apps: AppConfiguration[];
  createdAt: string;
  updatedAt: string;
  latestRun: RunSummary | null;
  /** Most recent run that finished as passed or failed; the source for stable summary metrics. */
  latestCompletedRun: RunSummary | null;
}

/**
 * A saved, explicit selection of applications for one repository. Groups store
 * app names rather than ids because auto-detected apps have no stable rows.
 */
export interface AppGroup {
  id: string;
  repositoryId: string;
  name: string;
  appNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AppGroupInput {
  name: string;
  appNames: string[];
}

export interface RepositoryDetail extends Repository {
  selectableApps: AppInput[];
  appGroups: AppGroup[];
  runs: RunSummary[];
}

/**
 * Display form for the run-trigger picker, where space is tight and the
 * working directory is shown alongside. Results views keep the full name so the
 * owning repository stays visible.
 */
export function shortAppName(name: string): string {
  const trimmed = name.trim();
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return lastSegment || trimmed;
}

export const activeRunStatuses: RunStatus[] = [
  "queued",
  "cloning",
  "setup",
  "building",
  "testing"
];

export const terminalRunStatuses: RunStatus[] = [
  "passed",
  "failed",
  "timed_out",
  "interrupted"
];

// ----- Slices: backend coverage per frontend app -------------------------------

export type SliceBackendFramework = "nestjs" | "express";

/** One backend a slice can reach, and how frontend calls to it are recognised. */
export interface SliceBackendConfig {
  /** Backend workspace, for example `apps/idp-api-service`. */
  directory: string;
  framework: SliceBackendFramework;
  /** Generated orval client the frontends import endpoint calls from (NestJS only). */
  clientPackage: string | null;
  /** NestJS root module relative to the workspace, normally `src/app.module.ts`. */
  rootModule: string | null;
  /** Express entry file relative to the workspace, normally `app.js`. */
  entryFile: string | null;
  /**
   * Names the backend's base URL goes by in frontend code, such as
   * `VITE_AUTH_API_HOST` or `apiHost`. Requests built from them are matched to
   * routes by path.
   */
  baseUrlNames: string[];
}

/**
 * How a repository's slices are derived. A slice is every backend file a
 * frontend app depends on, across one or more backends.
 */
export interface SliceConfig {
  backends: SliceBackendConfig[];
  /**
   * Frontend workspaces to slice. Empty means every `apps/*` workspace that
   * depends on one of the backends' client packages.
   */
  frontendDirectories: string[];
}

/**
 * Reads a stored recipe, upgrading the original single-backend shape
 * (`backendDirectory`, `clientPackage`, `rootModule`) to a backend list.
 */
export function normalizeSliceConfig(value: unknown): SliceConfig {
  const raw = (value ?? {}) as Record<string, unknown>;
  const strings = (input: unknown): string[] => (Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []);
  const text = (input: unknown): string | null => (typeof input === "string" && input ? input : null);
  if (!Array.isArray(raw.backends)) {
    return {
      backends: text(raw.backendDirectory)
        ? [
            {
              directory: text(raw.backendDirectory)!,
              framework: "nestjs",
              clientPackage: text(raw.clientPackage),
              rootModule: text(raw.rootModule) ?? "src/app.module.ts",
              entryFile: null,
              baseUrlNames: []
            }
          ]
        : [],
      frontendDirectories: strings(raw.frontendDirectories)
    };
  }
  return {
    backends: raw.backends.map((entry) => {
      const backend = (entry ?? {}) as Record<string, unknown>;
      const framework: SliceBackendFramework = backend.framework === "express" ? "express" : "nestjs";
      return {
        directory: text(backend.directory) ?? "",
        framework,
        clientPackage: framework === "nestjs" ? text(backend.clientPackage) : null,
        rootModule: framework === "nestjs" ? text(backend.rootModule) ?? "src/app.module.ts" : null,
        entryFile: framework === "express" ? text(backend.entryFile) ?? "app.js" : null,
        baseUrlNames: strings(backend.baseUrlNames)
      };
    }),
    frontendDirectories: strings(raw.frontendDirectories)
  };
}

export type SliceBuildStatus = "queued" | "running" | "passed" | "failed";

export interface SliceBuild {
  id: string;
  repositoryId: string;
  status: SliceBuildStatus;
  requestedRef: string;
  useLocalWorkingTree: boolean;
  resolvedSha: string | null;
  dirty: boolean;
  error: string | null;
  /** Number of slices written; null until the build finishes. */
  sliceCount: number | null;
  /** Frontends that could not be sliced, with the reason. */
  skipped: Array<{ frontendDirectory: string; reason: string }>;
  config: SliceConfig;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SliceEndpoint {
  /** Backend workspace serving the endpoint. Older builds stored one backend per slice. */
  backendDirectory?: string;
  httpMethod: string;
  path: string;
  controller: string;
  methodKey: string;
  /** Repository-relative controller file. */
  file: string;
  /** Generated client exports, or `file:line` request sites, that reach it. */
  clientNames: string[];
}

/** A hand-written request to a configured backend that matched no route. */
export interface SliceUnmatchedCall {
  backendDirectory: string;
  /** Repository-relative `file:line` of the request. */
  site: string;
  method: string | null;
  path: string;
}

/** One backend's share of a slice. */
export interface SliceBackendSummary {
  directory: string;
  endpointCount: number;
  fileCount: number;
  measuredFileCount: number;
  coverage: CoverageSummary;
}

export interface Slice {
  name: string;
  frontendDirectory: string;
  buildId: string;
  /** Commit the slice was traced from. */
  resolvedSha: string | null;
  builtAt: string;
  endpointCount: number;
  fileCount: number;
  /** Slice files that appear in the current coverage snapshot. */
  measuredFileCount: number;
  /** Current coverage of the slice, from the latest coverage snapshot. */
  coverage: CoverageSummary;
  /** Capture time and commit of the newest snapshot the coverage came from. */
  coverageCapturedAt: string | null;
  coverageSha: string | null;
  /** Per-backend breakdown; the slice totals sum these. */
  backends: SliceBackendSummary[];
  /** Requests that matched no route, worth checking when a slice looks small. */
  unmatchedCallCount: number;
}

export interface SliceDetail extends Slice {
  endpoints: SliceEndpoint[];
  unmatchedCalls: SliceUnmatchedCall[];
}

export interface SliceOverview {
  config: SliceConfig | null;
  builds: SliceBuild[];
  slices: Slice[];
}

export const activeSliceBuildStatuses: SliceBuildStatus[] = ["queued", "running"];
