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
  metric?: CoverageMetricName;
  maxPercent?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CoverageFileRow extends CoverageFileEntry {
  appName: string;
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
