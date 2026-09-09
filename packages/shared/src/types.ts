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
  runnerImage: string;
  setupCommand?: string;
  buildCommand?: string;
  testWorkerLimit: number;
  timeoutMinutes: number;
  environmentAllowlist: string[];
  autoDetect: boolean;
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
  runnerImage: string;
  setupCommand?: string;
  buildCommand?: string;
  testWorkerLimit: number;
  timeoutMinutes: number;
  environmentAllowlist: string[];
  autoDetect: boolean;
  apps: AppConfiguration[];
  createdAt: string;
  updatedAt: string;
  latestRun: RunSummary | null;
}

export interface RepositoryDetail extends Repository {
  selectableApps: AppInput[];
  runs: RunSummary[];
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
