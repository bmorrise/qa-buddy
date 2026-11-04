import { useEffect, useMemo, useState } from "react";
import type {
  CoverageFilePage,
  CoverageMetric,
  CoverageMetricName,
  CoverageSnapshot,
  RepositoryDetail,
  SliceOverview
} from "@qa-buddy/shared";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { FileRowWithGaps } from "../components/FileGaps";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Loading";

const metricLabels: Record<CoverageMetricName, string> = {
  lines: "Lines",
  statements: "Statements",
  functions: "Functions",
  branches: "Branches"
};

const thresholds = [
  { label: "All files", value: undefined },
  { label: "Under 80%", value: 80 },
  { label: "Under 50%", value: 50 },
  { label: "Under 25%", value: 25 },
  { label: "Zero coverage", value: 0 }
];

const pageSize = 100;

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Metric({ value }: { value: CoverageMetric | null }) {
  if (!value || value.percent === null) return <span className="metric-empty">N/A</span>;
  const tone = value.percent < 25 ? "critical" : value.percent < 50 ? "poor" : value.percent < 80 ? "fair" : "good";
  return (
    <span className={`gap-metric gap-metric-${tone}`}>
      <strong>{value.percent.toFixed(1)}%</strong>
      <small>{value.covered}/{value.total}</small>
    </span>
  );
}

export function CoverageGapsPage() {
  const { repositoryId = "" } = useParams();
  const [repository, setRepository] = useState<RepositoryDetail | null>(null);
  const [snapshots, setSnapshots] = useState<CoverageSnapshot[] | null>(null);
  const [page, setPage] = useState<CoverageFilePage | null>(null);
  const [error, setError] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const [sliceNames, setSliceNames] = useState<string[]>([]);
  const sliceName = searchParams.get("slice") ?? "";
  const [appName, setAppName] = useState("");
  const [metric, setMetric] = useState<CoverageMetricName>("branches");
  const [maxPercent, setMaxPercent] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ repository: RepositoryDetail }>(`/api/repositories/${repositoryId}`),
      api<{ snapshots: CoverageSnapshot[] }>(`/api/repositories/${repositoryId}/coverage`)
    ])
      .then(([repositoryResponse, snapshotResponse]) => {
        setRepository(repositoryResponse.repository);
        setSnapshots(snapshotResponse.snapshots);
      })
      .catch((caught: Error) => setError(caught.message));
    // Slices are optional, so a failure here never blocks the page.
    api<SliceOverview>(`/api/repositories/${repositoryId}/slices`)
      .then((overview) => setSliceNames(overview.slices.map((slice) => slice.name)))
      .catch(() => setSliceNames([]));
  }, [repositoryId]);

  useEffect(() => {
    if (!snapshots || snapshots.length === 0) return;
    const parameters = new URLSearchParams({
      metric,
      limit: String(pageSize),
      offset: String(offset)
    });
    if (appName) parameters.set("app", appName);
    if (sliceName) parameters.set("slice", sliceName);
    if (maxPercent !== undefined) parameters.set("maxPercent", String(maxPercent));
    if (search.trim()) parameters.set("search", search.trim());

    setLoadingFiles(true);
    api<CoverageFilePage>(`/api/repositories/${repositoryId}/coverage/files?${parameters.toString()}`)
      .then(setPage)
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setLoadingFiles(false));
  }, [repositoryId, snapshots, appName, sliceName, metric, maxPercent, search, offset]);

  const stalest = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return null;
    return snapshots.reduce((oldest, snapshot) => (snapshot.capturedAt < oldest.capturedAt ? snapshot : oldest));
  }, [snapshots]);

  if (error && !repository) return <div className="page"><div className="alert alert-error" role="alert">{error}</div></div>;
  if (!repository || !snapshots) return <Loading label="Loading coverage…" />;

  const exportLink = (format: "csv" | "json") => {
    const parameters = new URLSearchParams({ metric, format });
    if (appName) parameters.set("app", appName);
    if (sliceName) parameters.set("slice", sliceName);
    if (maxPercent !== undefined) parameters.set("maxPercent", String(maxPercent));
    if (search.trim()) parameters.set("search", search.trim());
    return `/api/repositories/${repositoryId}/coverage/files/export?${parameters.toString()}`;
  };

  const resetPaging = <T,>(setter: (value: T) => void) => (value: T) => {
    setOffset(0);
    setter(value);
  };

  return (
    <div className="page page-wide">
      <div className="breadcrumbs">
        <Link to="/repositories">Repositories</Link><span>/</span>
        <Link to={`/repositories/${repository.id}`}>{repository.name}</Link><span>/</span><span>Coverage gaps</span>
      </div>
      <section className="page-heading">
        <div>
          <span className="eyebrow">Per-file coverage</span>
          <h1>Coverage gaps</h1>
          <p className="muted">
            Captured from the most recent run of each app that used a GitHub ref. Local working tree runs never
            overwrite these snapshots.
          </p>
        </div>
        <div className="heading-actions">
          <Link to={`/repositories/${repository.id}`} className="button button-secondary">
            <Icon name="settings" size={16} />Back to repository
          </Link>
        </div>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {snapshots.length === 0 ? (
        <div className="empty-state panel">
          <h2>No coverage snapshots yet</h2>
          <p>
            Run this repository against a GitHub branch. Every app that produces a per-file coverage report updates its
            snapshot automatically.
          </p>
        </div>
      ) : (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div><span className="eyebrow">Snapshots</span><h2>Captured coverage</h2></div>
              {stalest && <span className="muted">Oldest capture {formatDate(stalest.capturedAt)}</span>}
            </div>
            <div className="table-scroll">
              <table className="coverage-table compact">
                <thead>
                  <tr><th>App</th><th>Files</th><th>Commit</th><th>Captured</th><th>Format</th></tr>
                </thead>
                <tbody>
                  {snapshots.map((snapshot) => (
                    <tr key={snapshot.appName}>
                      <td><strong>{snapshot.appName}</strong></td>
                      <td>{snapshot.fileCount}</td>
                      <td><code>{snapshot.resolvedSha?.slice(0, 8) ?? "—"}</code></td>
                      <td>{formatDate(snapshot.capturedAt)}</td>
                      <td><code>{snapshot.coverageFormat === "lcov" ? "LCOV" : "Istanbul"}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div><span className="eyebrow">Weakest first</span><h2>Files</h2></div>
              <div className="panel-heading-meta">
                <span className="muted">{page ? `${page.total} matching files` : "…"}</span>
                <span className="slice-export" role="group" aria-label="Download the matching files">
                  <Icon name="download" size={14} />
                  <a href={exportLink("csv")} download>CSV</a>
                  <a href={exportLink("json")} download>JSON</a>
                </span>
              </div>
            </div>
            <div className="gap-filters">
              <label>
                <span>App</span>
                <select value={appName} onChange={(event) => resetPaging(setAppName)(event.target.value)}>
                  <option value="">All apps</option>
                  {snapshots.map((snapshot) => (
                    <option key={snapshot.appName} value={snapshot.appName}>{snapshot.appName}</option>
                  ))}
                </select>
              </label>
              {(sliceNames.length > 0 || sliceName) && (
                <label>
                  <span>Slice</span>
                  <select
                    value={sliceName}
                    onChange={(event) => {
                      setOffset(0);
                      const next = new URLSearchParams(searchParams);
                      if (event.target.value) next.set("slice", event.target.value);
                      else next.delete("slice");
                      setSearchParams(next, { replace: true });
                    }}
                  >
                    <option value="">Any slice</option>
                    {Array.from(new Set([...sliceNames, ...(sliceName ? [sliceName] : [])])).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <span>Rank by</span>
                <select
                  value={metric}
                  onChange={(event) => resetPaging(setMetric)(event.target.value as CoverageMetricName)}
                >
                  {(Object.keys(metricLabels) as CoverageMetricName[]).map((name) => (
                    <option key={name} value={name}>{metricLabels[name]}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Threshold</span>
                <select
                  value={maxPercent === undefined ? "" : String(maxPercent)}
                  onChange={(event) =>
                    resetPaging(setMaxPercent)(event.target.value === "" ? undefined : Number(event.target.value))
                  }
                >
                  {thresholds.map((threshold) => (
                    <option key={threshold.label} value={threshold.value === undefined ? "" : String(threshold.value)}>
                      {threshold.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="gap-search">
                <span>Path contains</span>
                <input
                  value={search}
                  onChange={(event) => resetPaging(setSearch)(event.target.value)}
                  placeholder="src/billing"
                  autoComplete="off"
                />
              </label>
            </div>

            {page && page.files.length === 0 ? (
              <p className="empty-copy">No files match these filters.</p>
            ) : (
              <div className="table-scroll">
                <table className="coverage-table compact">
                  <thead>
                    <tr>
                      <th>File</th>
                      {appName === "" && <th>App</th>}
                      <th>Lines</th><th>Statements</th><th>Functions</th><th>Branches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page?.files.map((file) => (
                      <FileRowWithGaps
                        key={`${file.appName}:${file.path}`}
                        repositoryId={repositoryId}
                        path={file.path}
                        columnCount={appName === "" ? 6 : 5}
                      >
                        {appName === "" && <td>{file.appName}</td>}
                        <td><Metric value={file.lines} /></td>
                        <td><Metric value={file.statements} /></td>
                        <td><Metric value={file.functions} /></td>
                        <td><Metric value={file.branches} /></td>
                      </FileRowWithGaps>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {page && page.total > pageSize && (
              <div className="gap-paging">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={offset === 0 || loadingFiles}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                >
                  ← Previous
                </button>
                <span className="muted">
                  {offset + 1}–{Math.min(offset + pageSize, page.total)} of {page.total}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={offset + pageSize >= page.total || loadingFiles}
                  onClick={() => setOffset(offset + pageSize)}
                >
                  Next →
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
