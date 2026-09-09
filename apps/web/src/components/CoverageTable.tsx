import type { AppRun, CoverageMetric } from "@qa-buddy/shared";
import { StatusBadge } from "./StatusBadge";

function Metric({ value }: { value: CoverageMetric | null }) {
  if (!value) return <span className="metric-empty">N/A</span>;
  return (
    <span className="metric-value">
      <strong>{value.percent === null ? "—" : `${value.percent.toFixed(1)}%`}</strong>
      <small>
        {value.covered}/{value.total}
      </small>
      {value.percent !== null && <span className="coverage-track"><span style={{ width: `${value.percent}%` }} /></span>}
    </span>
  );
}

function TestSummary({ app }: { app: AppRun }) {
  if (!app.testResults) return <span className="metric-empty">N/A</span>;
  return (
    <span className="metric-value test-summary-value">
      <strong>{app.testResults.passed}/{app.testResults.total}</strong>
      <small>{app.testResults.failed ? `${app.testResults.failed} failed` : "passed"}</small>
    </span>
  );
}

export function CoverageTable({ appRuns, compact = false }: { appRuns: AppRun[]; compact?: boolean }) {
  return (
    <div className="table-scroll">
      <table className={compact ? "coverage-table compact" : "coverage-table"}>
        <thead>
          <tr>
            <th>App</th>
            <th>Status</th>
            {!compact && <th>Tests</th>}
            <th>Lines</th>
            <th>Statements</th>
            <th>Functions</th>
            <th>Branches</th>
          </tr>
        </thead>
        <tbody>
          {appRuns.map((app) => (
            <tr key={app.id}>
              <td>
                <strong>{app.name}</strong>
                {!compact && <small className="cell-subtitle">{app.workingDirectory}</small>}
              </td>
              <td>
                <StatusBadge status={app.status} />
              </td>
              {!compact && <td><TestSummary app={app} /></td>}
              <td>
                <Metric value={app.coverage?.lines ?? null} />
              </td>
              <td>
                <Metric value={app.coverage?.statements ?? null} />
              </td>
              <td>
                <Metric value={app.coverage?.functions ?? null} />
              </td>
              <td>
                <Metric value={app.coverage?.branches ?? null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
