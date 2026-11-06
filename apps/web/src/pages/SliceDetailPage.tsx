import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CoverageFilePage, CoverageMetric, CoverageMetricName, Repository, SliceDetail } from "@qa-buddy/shared";
import { api } from "../api";
import { FileRowWithGaps } from "../components/FileGaps";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Loading";
import { coverageTone, Pizza } from "../components/Pizza";
import { formatDateTime, formatPercentValue, reachedBackends, sliceMetricLabels } from "./SlicesPage";

const metricOrder: CoverageMetricName[] = ["branches", "functions", "lines", "statements"];
const weakestCount = 15;

function FileMetric({ value }: { value: CoverageMetric | null }) {
  if (!value || value.percent === null) return <span className="metric-empty">N/A</span>;
  return (
    <span className={`gap-metric gap-metric-${coverageTone(value.percent)}`}>
      <strong>{value.percent.toFixed(1)}%</strong>
      <small>{value.covered}/{value.total}</small>
    </span>
  );
}

export function SliceDetailPage() {
  const { repositoryId = "", sliceName = "" } = useParams();
  const [repository, setRepository] = useState<Repository | null>(null);
  const [slice, setSlice] = useState<SliceDetail | null>(null);
  const [weakest, setWeakest] = useState<CoverageFilePage | null>(null);
  const [metric, setMetric] = useState<CoverageMetricName>("branches");
  const [endpointFilter, setEndpointFilter] = useState("");
  const [endpointBackend, setEndpointBackend] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ repository: Repository }>(`/api/repositories/${repositoryId}`),
      api<{ slice: SliceDetail }>(`/api/repositories/${repositoryId}/slices/${encodeURIComponent(sliceName)}`)
    ])
      .then(([repositoryResponse, sliceResponse]) => {
        setRepository(repositoryResponse.repository);
        setSlice(sliceResponse.slice);
      })
      .catch((caught: Error) => setError(caught.message));
  }, [repositoryId, sliceName]);

  useEffect(() => {
    const parameters = new URLSearchParams({ slice: sliceName, metric, limit: String(weakestCount) });
    api<CoverageFilePage>(`/api/repositories/${repositoryId}/coverage/files?${parameters.toString()}`)
      .then(setWeakest)
      .catch((caught: Error) => setError(caught.message));
  }, [repositoryId, sliceName, metric]);

  const endpoints = useMemo(() => {
    if (!slice) return [];
    const query = endpointFilter.trim().toLowerCase();
    return slice.endpoints.filter(
      (endpoint) =>
        (!endpointBackend || endpoint.backendDirectory === endpointBackend) &&
        (!query ||
          [endpoint.path, endpoint.controller, endpoint.methodKey, endpoint.httpMethod, ...endpoint.clientNames].some((value) =>
            value.toLowerCase().includes(query)
          ))
    );
  }, [slice, endpointFilter, endpointBackend]);

  if (error && (!repository || !slice)) {
    return <div className="page"><div className="alert alert-error" role="alert">{error}</div></div>;
  }
  if (!repository || !slice) return <Loading label="Slicing…" />;

  const handlerCount = new Set(slice.endpoints.map((endpoint) => endpoint.file)).size;
  const gapsLink = `/repositories/${repository.id}/coverage?slice=${encodeURIComponent(slice.name)}`;
  const exportLink = (format: "csv" | "json") =>
    `/api/repositories/${repository.id}/coverage/files/export?${new URLSearchParams({ slice: slice.name, metric, format }).toString()}`;
  const backends = reachedBackends(slice);
  const multipleBackends = backends.length > 1;

  return (
    <div className="page page-wide">
      <div className="breadcrumbs">
        <Link to="/repositories">Repositories</Link><span>/</span>
        <Link to={`/repositories/${repository.id}`}>{repository.name}</Link><span>/</span>
        <Link to={`/repositories/${repository.id}/slices`}>Slices</Link><span>/</span><span>{slice.name}</span>
      </div>
      <section className="page-heading">
        <div>
          <span className="eyebrow">Slice · {slice.frontendDirectory}</span>
          <h1>{slice.name}</h1>
          <p>
            {slice.endpointCount} endpoints across {handlerCount} handler files in{" "}
            {backends.map((backend, index) => (
              <span key={backend.directory}>{index > 0 && (index === backends.length - 1 ? " and " : ", ")}<code>{backend.directory}</code></span>
            ))}
            , reaching {slice.fileCount} backend files. Traced from <code>{slice.resolvedSha?.slice(0, 8) ?? "unknown"}</code> on {formatDateTime(slice.builtAt)}.
          </p>
        </div>
        <div className="heading-actions">
          <Link to={gapsLink} className="button button-secondary"><Icon name="coverage" size={16} />All slice files</Link>
          <Link to={`/repositories/${repository.id}/slices`} className="button button-secondary"><Icon name="layers" size={16} />All slices</Link>
        </div>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <section className="slice-metrics">
        {metricOrder.map((name) => {
          const value = slice.coverage[name];
          return (
            <div key={name} className="panel slice-metric">
              <Pizza percent={value?.percent ?? null} size={84} label={`${formatPercentValue(value?.percent)} ${sliceMetricLabels[name].toLowerCase()} covered`} />
              <div>
                <span className="eyebrow">{sliceMetricLabels[name]}</span>
                <strong className={`slice-percent slice-percent-${coverageTone(value?.percent)}`}>{formatPercentValue(value?.percent)}</strong>
                <span className="muted">{value ? `${value.covered.toLocaleString()} of ${value.total.toLocaleString()}` : "Not measured"}</span>
              </div>
            </div>
          );
        })}
      </section>
      <p className="muted slice-measured-note">
        {slice.measuredFileCount} of {slice.fileCount} slice files appear in the latest coverage reports
        {slice.coverageCapturedAt ? ` (newest ${slice.coverageSha?.slice(0, 8) ?? "unknown"}, ${formatDateTime(slice.coverageCapturedAt)})` : ""}.
        Files with no executable code, such as type-only modules, are not reported.
      </p>

      {multipleBackends && (
        <section className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Where it comes from</span><h2>Backends</h2></div>
            <span className="muted">The slice totals above add these together.</span>
          </div>
          <div className="table-scroll">
            <table className="coverage-table compact">
              <thead><tr><th>Backend</th><th>Endpoints</th><th>Files</th><th>Measured</th><th>Lines</th><th>Statements</th><th>Functions</th><th>Branches</th></tr></thead>
              <tbody>
                {backends.map((backend) => (
                  <tr key={backend.directory}>
                    <td><code>{backend.directory}</code></td>
                    <td>{backend.endpointCount}</td>
                    <td>{backend.fileCount}</td>
                    <td>{backend.measuredFileCount}</td>
                    <td><FileMetric value={backend.coverage.lines} /></td>
                    <td><FileMetric value={backend.coverage.statements} /></td>
                    <td><FileMetric value={backend.coverage.functions} /></td>
                    <td><FileMetric value={backend.coverage.branches} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div><span className="eyebrow">Weakest first</span><h2>Files to improve</h2></div>
          <div className="panel-heading-meta">
            <div className="filter-tabs" role="group" aria-label="Rank files by">
              {metricOrder.map((name) => (
                <button type="button" key={name} className={metric === name ? "selected" : ""} aria-pressed={metric === name} onClick={() => setMetric(name)}>
                  {sliceMetricLabels[name]}
                </button>
              ))}
            </div>
            <span className="slice-export" role="group" aria-label="Download every file in this slice">
              <Icon name="download" size={14} />
              <a href={exportLink("csv")} download>CSV</a>
              <a href={exportLink("json")} download>JSON</a>
            </span>
            <Link to={gapsLink}>All {weakest?.total ?? ""} files →</Link>
          </div>
        </div>
        {weakest && weakest.files.length === 0 ? (
          <p className="empty-copy">No coverage has been recorded for this slice&apos;s files yet. Run the backend tests to measure it.</p>
        ) : (
          <div className="table-scroll">
            <table className="coverage-table compact">
              <thead><tr><th>File</th><th>Lines</th><th>Statements</th><th>Functions</th><th>Branches</th></tr></thead>
              <tbody>
                {weakest?.files.map((file) => (
                  <FileRowWithGaps key={file.path} repositoryId={repository.id} path={file.path} columnCount={5}>
                    <td><FileMetric value={file.lines} /></td>
                    <td><FileMetric value={file.statements} /></td>
                    <td><FileMetric value={file.functions} /></td>
                    <td><FileMetric value={file.branches} /></td>
                  </FileRowWithGaps>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><span className="eyebrow">What the frontend calls</span><h2>Endpoints</h2></div>
          <div className="slice-endpoint-filters">
            {multipleBackends && (
              <label>
                <span className="sr-only">Backend</span>
                <select value={endpointBackend} onChange={(event) => setEndpointBackend(event.target.value)}>
                  <option value="">All backends</option>
                  {backends.map((backend) => <option key={backend.directory} value={backend.directory}>{backend.directory}</option>)}
                </select>
              </label>
            )}
            <label className="slice-endpoint-filter">
              <span className="sr-only">Filter endpoints</span>
              <input value={endpointFilter} onChange={(event) => setEndpointFilter(event.target.value)} placeholder="Filter by path, handler or caller" autoComplete="off" />
            </label>
          </div>
        </div>
        <div className="table-scroll">
          <table className="coverage-table compact slice-endpoints">
            <thead><tr><th>Method</th><th>Path</th>{multipleBackends && <th>Backend</th>}<th>Handler</th><th>Called through</th></tr></thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={`${endpoint.backendDirectory} ${endpoint.httpMethod} ${endpoint.path}`}>
                  <td><span className={`http-method http-method-${endpoint.httpMethod}`}>{endpoint.httpMethod.toUpperCase()}</span></td>
                  <td><code>{endpoint.path}</code></td>
                  {multipleBackends && <td><code>{endpoint.backendDirectory?.split("/").at(-1)}</code></td>}
                  <td><strong>{endpoint.methodKey ? `${endpoint.controller}.${endpoint.methodKey}` : endpoint.controller}</strong><small className="cell-subtitle">{endpoint.file}</small></td>
                  <td><code>{endpoint.clientNames.join(", ")}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {endpoints.length === 0 && <p className="empty-copy">No endpoints match this filter.</p>}
      </section>

      {slice.unmatchedCalls.length > 0 && (
        <details className="panel slice-unmatched">
          <summary>
            <span className="slice-setup-title">
              <Icon name="chevron" size={14} />
              <span><span className="eyebrow">Worth a look</span><strong>{slice.unmatchedCalls.length} request{slice.unmatchedCalls.length === 1 ? "" : "s"} matched no route</strong></span>
            </span>
            <span className="muted">Their backend code is not in this slice</span>
          </summary>
          <p className="muted slice-unmatched-copy">
            These requests are built from a configured base URL but match no route, usually because the route was removed,
            the path is assembled at runtime, or the request goes to a backend that is not in the recipe.
          </p>
          <div className="table-scroll">
            <table className="coverage-table compact">
              <thead><tr><th>Method</th><th>Path</th><th>Backend</th><th>Request</th></tr></thead>
              <tbody>
                {slice.unmatchedCalls.map((call) => (
                  <tr key={`${call.site} ${call.path}`}>
                    <td><span className={`http-method http-method-${call.method ?? "get"}`}>{call.method?.toUpperCase() ?? "ANY"}</span></td>
                    <td><code>{call.path}</code></td>
                    <td><code>{call.backendDirectory}</code></td>
                    <td><code>{call.site}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
