import { useState } from "react";
import type { AppRun, TestCaseResult, TestCaseStatus } from "@qa-buddy/shared";

const statusOrder: Record<TestCaseStatus, number> = { failed: 0, skipped: 1, todo: 2, passed: 3 };

function duration(value: number | null): string {
  if (value === null) return "";
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function statusLabel(status: TestCaseStatus): string {
  return status === "todo" ? "Todo" : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function TestCase({ testCase }: { testCase: TestCaseResult }) {
  return (
    <div className={`test-case test-case-${testCase.status}`}>
      <div className="test-case-heading">
        <span className={`test-case-status test-case-status-${testCase.status}`}>{statusLabel(testCase.status)}</span>
        <div>
          <strong>{testCase.fullName}</strong>
          {testCase.filePath && <small>{testCase.filePath}</small>}
        </div>
        {testCase.durationMs !== null && <span className="test-duration">{duration(testCase.durationMs)}</span>}
      </div>
      {testCase.failureMessage && <pre>{testCase.failureMessage}</pre>}
    </div>
  );
}

export function TestCaseReadout({ appRuns }: { appRuns: AppRun[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="test-app-list">
      {appRuns.map((app) => {
        const open = expanded.has(app.id);
        const results = app.testResults;
        const cases = results
          ? [...results.testCases].sort((left, right) => statusOrder[left.status] - statusOrder[right.status])
          : [];
        return (
          <article className="test-app" key={app.id}>
            <button type="button" className="test-app-toggle" onClick={() => toggle(app.id)} aria-expanded={open}>
              <span className="test-app-chevron">{open ? "−" : "+"}</span>
              <span className="test-app-name"><strong>{app.name}</strong><small>{app.workingDirectory}</small></span>
              {results ? (
                <span className="test-counts">
                  <span className="test-count-passed">{results.passed} passed</span>
                  {results.failed > 0 && <span className="test-count-failed">{results.failed} failed</span>}
                  {results.skipped > 0 && <span>{results.skipped} skipped</span>}
                  {results.todo > 0 && <span>{results.todo} todo</span>}
                </span>
              ) : <span className="muted">No structured results</span>}
            </button>
            {open && (
              <div className="test-case-list">
                {results ? (
                  cases.length ? cases.map((testCase, index) => <TestCase key={`${testCase.filePath ?? "test"}-${testCase.fullName}-${index}`} testCase={testCase} />) : <p>No individual test cases were reported.</p>
                ) : <p>{app.testResultsError ?? "This test command did not produce a supported Jest/Vitest JSON report. Use the full log for details."}</p>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
