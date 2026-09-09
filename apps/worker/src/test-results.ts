import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { TestCaseResult, TestCaseStatus, TestResults } from "@qa-buddy/shared";

export const TEST_RESULTS_FILE_NAME = ".qa-buddy-test-results.json";
const maximumReportBytes = 50 * 1024 * 1024;
const maximumTestCases = 25_000;
const maximumFailureMessageLength = 8_000;

interface RawAssertionResult {
  ancestorTitles?: unknown;
  title?: unknown;
  fullName?: unknown;
  status?: unknown;
  duration?: unknown;
  failureMessages?: unknown;
}

interface RawSuiteResult {
  name?: unknown;
  status?: unknown;
  message?: unknown;
  failureMessage?: unknown;
  assertionResults?: unknown;
}

interface RawTestReport {
  testResults?: unknown;
}

function limitedText(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.length > limit ? `${value.slice(0, limit)}\n[Failure message truncated by QA Buddy]` : value;
}

function testStatus(value: unknown): TestCaseStatus {
  if (value === "passed") return "passed";
  if (value === "failed") return "failed";
  if (value === "todo") return "todo";
  return "skipped";
}

function relativeFilePath(repositoryDirectory: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.startsWith("file://") ? new URL(value).pathname : value;
  if (!path.isAbsolute(candidate)) return candidate.replaceAll("\\", "/");
  const relative = path.relative(repositoryDirectory, candidate);
  return relative.startsWith("..") ? path.basename(candidate) : relative.replaceAll("\\", "/");
}

function assertionFailureMessage(assertion: RawAssertionResult): string | null {
  if (!Array.isArray(assertion.failureMessages)) return null;
  return limitedText(
    assertion.failureMessages.filter((message): message is string => typeof message === "string").join("\n\n"),
    maximumFailureMessageLength
  );
}

export function parseTestResults(contents: string, repositoryDirectory: string): TestResults {
  let report: RawTestReport;
  try {
    report = JSON.parse(contents) as RawTestReport;
  } catch {
    throw new Error("Structured test report contains malformed JSON");
  }
  if (!Array.isArray(report.testResults)) {
    throw new Error("Structured test report does not contain a testResults array");
  }

  const testCases: TestCaseResult[] = [];
  for (const rawSuite of report.testResults as RawSuiteResult[]) {
    const filePath = relativeFilePath(repositoryDirectory, rawSuite.name);
    const assertions = Array.isArray(rawSuite.assertionResults)
      ? (rawSuite.assertionResults as RawAssertionResult[])
      : [];
    let failedAssertions = 0;

    for (const assertion of assertions) {
      if (testCases.length >= maximumTestCases) break;
      const status = testStatus(assertion.status);
      if (status === "failed") failedAssertions += 1;
      const ancestorTitles = Array.isArray(assertion.ancestorTitles)
        ? assertion.ancestorTitles.filter((title): title is string => typeof title === "string" && Boolean(title.trim()))
        : [];
      const name = limitedText(assertion.title, 1_000) ?? "Unnamed test";
      const fullName = limitedText(assertion.fullName, 2_000) ?? [...ancestorTitles, name].join(" ");
      testCases.push({
        name,
        fullName,
        ancestorTitles,
        filePath,
        status,
        durationMs:
          typeof assertion.duration === "number" && Number.isFinite(assertion.duration)
            ? Math.max(0, assertion.duration)
            : null,
        failureMessage: status === "failed" ? assertionFailureMessage(assertion) : null
      });
    }

    const suiteMessage = limitedText(
      typeof rawSuite.failureMessage === "string" ? rawSuite.failureMessage : rawSuite.message,
      maximumFailureMessageLength
    );
    if (testCases.length < maximumTestCases && failedAssertions === 0 && (rawSuite.status === "failed" || suiteMessage)) {
      const suiteName = filePath ? `Suite failure: ${filePath}` : "Suite failed before tests completed";
      testCases.push({
        name: suiteName,
        fullName: suiteName,
        ancestorTitles: [],
        filePath,
        status: "failed",
        durationMs: null,
        failureMessage: suiteMessage
      });
    }
  }

  const count = (status: TestCaseStatus): number => testCases.filter((testCase) => testCase.status === status).length;
  return {
    total: testCases.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    todo: count("todo"),
    testCases
  };
}

export function readTestResults(repositoryDirectory: string, workingDirectory: string): TestResults | null {
  const repositoryRoot = path.resolve(repositoryDirectory);
  const reportPath = path.resolve(repositoryDirectory, workingDirectory, TEST_RESULTS_FILE_NAME);
  if (!reportPath.startsWith(`${repositoryRoot}${path.sep}`) || !existsSync(reportPath)) return null;
  if (statSync(reportPath).size > maximumReportBytes) {
    throw new Error("Structured test report exceeded the 50 MB safety limit");
  }
  return parseTestResults(readFileSync(reportPath, "utf8"), repositoryRoot);
}
