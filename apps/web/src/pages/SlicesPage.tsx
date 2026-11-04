import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  activeSliceBuildStatuses,
  type CoverageMetricName,
  type Repository,
  type Slice,
  type SliceBuild,
  type SliceConfig,
  type SliceOverview
} from "@qa-buddy/shared";
import { api } from "../api";
import { CoverageTrends } from "../components/CoverageTrends";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Loading";
import { coverageTone, Pizza } from "../components/Pizza";

export const sliceMetricLabels: Record<CoverageMetricName, string> = {
  branches: "Branches",
  functions: "Functions",
  lines: "Lines",
  statements: "Statements"
};
const metricOrder: CoverageMetricName[] = ["branches", "functions", "lines", "statements"];

const buildStatusLabels: Record<SliceBuild["status"], string> = {
  queued: "In the queue",
  running: "In the oven",
  passed: "Baked",
  failed: "Burnt"
};

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatPercentValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : `${value.toFixed(1)}%`;
}

/** Splits a comma or newline separated list, dropping blanks. */
function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function SliceSetup({
  repositoryId,
  config,
  onSaved
}: {
  repositoryId: string;
  config: SliceConfig | null;
  onSaved: (config: SliceConfig) => void;
}) {
  const [backendDirectory, setBackendDirectory] = useState(config?.backendDirectory ?? "");
  const [clientPackage, setClientPackage] = useState(config?.clientPackage ?? "");
  const [rootModule, setRootModule] = useState(config?.rootModule ?? "src/app.module.ts");
  const [frontends, setFrontends] = useState(config?.frontendDirectories.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await api<{ config: SliceConfig }>(`/api/repositories/${repositoryId}/slices/config`, {
        method: "PUT",
        body: JSON.stringify({ backendDirectory, clientPackage, rootModule, frontendDirectories: parseList(frontends) })
      });
      onSaved(response.config);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the slice setup");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="panel slice-setup" open={!config}>
      <summary>
        <span><span className="eyebrow">Recipe</span><strong>Slice setup</strong></span>
        <span className="muted">
          {config
            ? `${config.backendDirectory} · ${config.frontendDirectories.length ? `${config.frontendDirectories.length} frontends` : "every app using the client"}`
            : "Not set up yet"}
        </span>
      </summary>
      <form className="slice-setup-form" onSubmit={(event) => void save(event)}>
        <p className="muted">
          A slice is every backend file one frontend depends on: QA Buddy follows the frontend's imports to the
          generated API client calls it makes, matches them to the NestJS controllers that serve them, and follows the
          controllers' imports. Shared code belongs to every slice that uses it.
        </p>
        <div className="slice-setup-grid">
          <label>
            <span>Backend workspace</span>
            <input value={backendDirectory} onChange={(event) => setBackendDirectory(event.target.value)} placeholder="apps/idp-api-service" required />
            <small>The NestJS app whose coverage the slices measure.</small>
          </label>
          <label>
            <span>Generated client package</span>
            <input value={clientPackage} onChange={(event) => setClientPackage(event.target.value)} placeholder="@acme/api-client" required />
            <small>The orval client the frontends import endpoint calls from.</small>
          </label>
          <label>
            <span>Root module</span>
            <input value={rootModule} onChange={(event) => setRootModule(event.target.value)} placeholder="src/app.module.ts" />
            <small>Relative to the backend workspace. Used to match operation ids exactly.</small>
          </label>
          <label>
            <span>Frontends</span>
            <input value={frontends} onChange={(event) => setFrontends(event.target.value)} placeholder="Every apps/* workspace using the client" />
            <small>Comma separated, for example apps/idinspect, apps/idcloud. Leave blank for all.</small>
          </label>
        </div>
        {error && <p className="inline-error slice-setup-error" role="alert">{error}</p>}
        <div className="slice-setup-actions">
          <button type="submit" className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save recipe"}</button>
        </div>
      </form>
    </details>
  );
}

function BuildStatus({ build }: { build: SliceBuild }) {
  const active = activeSliceBuildStatuses.includes(build.status);
  return (
    <div className={`slice-build slice-build-${build.status}`} role="status">
      <span className={`status status-${build.status}`}>{buildStatusLabels[build.status]}</span>
      <span>
        {active ? "Tracing endpoints from " : "Built from "}
        <code>{build.useLocalWorkingTree ? "local working tree" : build.requestedRef}</code>
        {build.resolvedSha && <code> · {build.resolvedSha.slice(0, 8)}{build.dirty ? "+dirty" : ""}</code>}
      </span>
      {!active && <span className="muted">{formatDateTime(build.finishedAt)}</span>}
      {build.status === "passed" && build.sliceCount !== null && (
        <span className="muted">{build.sliceCount} slice{build.sliceCount === 1 ? "" : "s"}</span>
      )}
      <a className="slice-build-log" href={`/api/slice-builds/${build.id}/log`} target="_blank" rel="noreferrer">Log ↗</a>
      {build.error && <p className="slice-build-error">{build.error}</p>}
      {build.skipped.length > 0 && (
        <p className="slice-build-skipped">
          Skipped {build.skipped.map((item) => `${item.frontendDirectory} (${item.reason})`).join("; ")}
        </p>
      )}
    </div>
  );
}

function SliceCard({ repositoryId, slice, metric }: { repositoryId: string; slice: Slice; metric: CoverageMetricName }) {
  const value = slice.coverage[metric];
  const percent = value?.percent ?? null;
  return (
    <Link to={`/repositories/${repositoryId}/slices/${encodeURIComponent(slice.name)}`} className="panel slice-card">
      <div className="slice-card-heading">
        <div>
          <strong>{slice.name}</strong>
          <code>{slice.frontendDirectory}</code>
        </div>
        <Icon name="chevron" size={14} />
      </div>
      <div className="slice-card-body">
        <Pizza percent={percent} size={108} label={`${slice.name}: ${formatPercentValue(percent)} ${sliceMetricLabels[metric].toLowerCase()} covered`} />
        <div className="slice-card-stat">
          <span className={`slice-percent slice-percent-${coverageTone(percent)}`}>{formatPercentValue(percent)}</span>
          <span className="muted">{sliceMetricLabels[metric]}{value ? ` · ${value.covered.toLocaleString()}/${value.total.toLocaleString()}` : ""}</span>
        </div>
      </div>
      <dl className="slice-card-facts">
        <div><dt>Endpoints</dt><dd>{slice.endpointCount}</dd></div>
        <div><dt>Backend files</dt><dd>{slice.fileCount}</dd></div>
        <div><dt>Measured</dt><dd title="Slice files that appear in the latest coverage report">{slice.measuredFileCount}</dd></div>
      </dl>
    </Link>
  );
}

export function SlicesPage() {
  const { repositoryId = "" } = useParams();
  const [repository, setRepository] = useState<Repository | null>(null);
  const [overview, setOverview] = useState<SliceOverview | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<CoverageMetricName>("branches");
  const [useLocalWorkingTree, setUseLocalWorkingTree] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const response = await api<SliceOverview>(`/api/repositories/${repositoryId}/slices`);
    setOverview(response);
    return response;
  }, [repositoryId]);

  useEffect(() => {
    Promise.all([api<{ repository: Repository }>(`/api/repositories/${repositoryId}`), load()])
      .then(([repositoryResponse]) => setRepository(repositoryResponse.repository))
      .catch((caught: Error) => setError(caught.message));
  }, [repositoryId, load]);

  const latestBuild = overview?.builds[0] ?? null;
  const building = latestBuild !== null && activeSliceBuildStatuses.includes(latestBuild.status);

  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => {
      load().catch((caught: Error) => setError(caught.message));
    }, 2_000);
    return () => clearInterval(timer);
  }, [building, load]);

  const startBuild = async () => {
    setStarting(true);
    setError("");
    try {
      await api(`/api/repositories/${repositoryId}/slices/builds`, {
        method: "POST",
        body: JSON.stringify({ useLocalWorkingTree })
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to start the slice build");
    } finally {
      setStarting(false);
    }
  };

  if (error && (!repository || !overview)) {
    return <div className="page"><div className="alert alert-error" role="alert">{error}</div></div>;
  }
  if (!repository || !overview) return <Loading label="Preheating the oven…" />;

  const { config, slices } = overview;
  const scopes = slices.map((slice) => ({ id: slice.name, name: slice.name, appNames: [slice.name] }));

  return (
    <div className="page page-wide">
      <div className="breadcrumbs">
        <Link to="/repositories">Repositories</Link><span>/</span>
        <Link to={`/repositories/${repository.id}`}>{repository.name}</Link><span>/</span><span>Slices</span>
      </div>
      <section className="page-heading">
        <div>
          <span className="eyebrow">Backend coverage by app</span>
          <h1>Slices <span aria-hidden="true">🍕</span></h1>
          <p>
            Each slice is the share of the backend one frontend depends on, shared code included. Coverage comes from the
            latest backend coverage snapshot, and every run adds a point to each slice&apos;s trend.
          </p>
        </div>
        <div className="heading-actions slice-heading-actions">
          {repository.localPath && (
            <label className="slice-local-toggle">
              <input type="checkbox" checked={useLocalWorkingTree} onChange={(event) => setUseLocalWorkingTree(event.target.checked)} />
              Local working tree
            </label>
          )}
          <button type="button" className="button button-primary" onClick={() => void startBuild()} disabled={!config || building || starting}>
            <Icon name="sparkles" size={16} />{building ? "Baking…" : slices.length ? "Rebake slices" : "Bake slices"}
          </button>
        </div>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {latestBuild && <BuildStatus build={latestBuild} />}

      <SliceSetup
        key={config ? JSON.stringify(config) : "new"}
        repositoryId={repository.id}
        config={config}
        onSaved={(saved) => setOverview((current) => (current ? { ...current, config: saved } : current))}
      />

      {slices.length === 0 ? (
        <div className="empty-state panel">
          <h2>No slices yet</h2>
          <p>
            {config
              ? "Bake slices to trace which backend files each frontend depends on. It reads the source only, so it takes seconds rather than minutes."
              : "Save a recipe above, then bake slices to see how much of each app's backend is covered."}
          </p>
        </div>
      ) : (
        <>
          <section className="slice-grid-heading">
            <div>
              <span className="eyebrow">Current coverage</span>
              <h2>{slices.length} slice{slices.length === 1 ? "" : "s"}</h2>
              <span className="muted">
                Traced from <code>{slices[0]!.resolvedSha?.slice(0, 8) ?? "unknown"}</code> on {formatDateTime(slices[0]!.builtAt)}
                {slices[0]!.coverageCapturedAt && <> · coverage from <code>{slices[0]!.coverageSha?.slice(0, 8)}</code> on {formatDateTime(slices[0]!.coverageCapturedAt)}</>}
              </span>
            </div>
            <div className="filter-tabs" role="group" aria-label="Coverage metric">
              {metricOrder.map((name) => (
                <button type="button" key={name} className={metric === name ? "selected" : ""} aria-pressed={metric === name} onClick={() => setMetric(name)}>
                  {sliceMetricLabels[name]}
                </button>
              ))}
            </div>
          </section>
          <div className="slice-grid">
            {slices.map((slice) => <SliceCard key={slice.name} repositoryId={repository.id} slice={slice} metric={metric} />)}
          </div>
          <CoverageTrends
            repositoryId={repository.id}
            repositoryName={`${repository.name} slices`}
            groups={scopes}
            includeAllTab={false}
            historyPath={`/api/repositories/${repository.id}/slices/history`}
            refreshKey={`${slices[0]!.buildId}:${slices[0]!.coverageCapturedAt ?? ""}`}
            goal={repository.coverageGoal}
            eyebrow="Every run"
            title="Slice trend"
            scopeLabel="Slice"
          />
        </>
      )}
    </div>
  );
}
