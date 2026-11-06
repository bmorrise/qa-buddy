import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  activeSliceBuildStatuses,
  type CoverageMetricName,
  type Repository,
  type Slice,
  type SliceBackendConfig,
  type SliceBackendFramework,
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

interface BackendDraft {
  key: number;
  directory: string;
  framework: SliceBackendFramework;
  clientPackage: string;
  rootModule: string;
  entryFile: string;
  baseUrlNames: string;
}

let draftKey = 0;
function toDraft(backend?: SliceBackendConfig): BackendDraft {
  draftKey += 1;
  return {
    key: draftKey,
    directory: backend?.directory ?? "",
    framework: backend?.framework ?? "nestjs",
    clientPackage: backend?.clientPackage ?? "",
    rootModule: backend?.rootModule ?? "src/app.module.ts",
    entryFile: backend?.entryFile ?? "app.js",
    baseUrlNames: backend?.baseUrlNames.join(", ") ?? ""
  };
}

export function describeRecipe(config: SliceConfig | null): string {
  if (!config) return "Not set up yet";
  const backends = config.backends.map((backend) => backend.directory.split("/").at(-1)).join(" + ");
  const frontends = config.frontendDirectories.length
    ? `${config.frontendDirectories.length} frontend${config.frontendDirectories.length === 1 ? "" : "s"}`
    : "every app using a client";
  return `${backends} · ${frontends}`;
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
  const [backends, setBackends] = useState<BackendDraft[]>(() => (config?.backends.length ? config.backends.map(toDraft) : [toDraft()]));
  const [frontends, setFrontends] = useState(config?.frontendDirectories.join(", ") ?? "");
  const [open, setOpen] = useState(!config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = (key: number, patch: Partial<BackendDraft>) =>
    setBackends((current) => current.map((backend) => (backend.key === key ? { ...backend, ...patch } : backend)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await api<{ config: SliceConfig }>(`/api/repositories/${repositoryId}/slices/config`, {
        method: "PUT",
        body: JSON.stringify({
          backends: backends.map((backend) => ({
            directory: backend.directory,
            framework: backend.framework,
            clientPackage: backend.framework === "nestjs" ? backend.clientPackage : null,
            rootModule: backend.framework === "nestjs" ? backend.rootModule : null,
            entryFile: backend.framework === "express" ? backend.entryFile : null,
            baseUrlNames: parseList(backend.baseUrlNames)
          })),
          frontendDirectories: parseList(frontends)
        })
      });
      onSaved(response.config);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the slice setup");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="panel slice-setup" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="slice-setup-title">
          <Icon name="chevron" size={14} />
          <span><span className="eyebrow">Recipe</span><strong>Slice setup</strong></span>
        </span>
        <span className="slice-setup-meta">
          <span className="muted">{describeRecipe(config)}</span>
          <span className="slice-setup-toggle">{open ? "Close" : config ? "Edit recipe" : "Set up"}</span>
        </span>
      </summary>
      <form className="slice-setup-form" onSubmit={(event) => void save(event)}>
        <p className="muted">
          A slice is every backend file one frontend depends on. QA Buddy follows the frontend&apos;s imports to the
          requests it makes, matches them to backend routes, and follows those routes&apos; imports. Requests are
          recognised two ways: calls through a generated API client, and hand-written URLs built from a base URL
          variable. Shared code belongs to every slice that uses it.
        </p>
        {backends.map((backend, index) => (
          <fieldset key={backend.key} className="slice-backend">
            <legend>Backend {index + 1}</legend>
            <div className="slice-setup-grid">
              <label>
                <span>Workspace</span>
                <input value={backend.directory} onChange={(event) => update(backend.key, { directory: event.target.value })} placeholder="apps/idp-api-service" required />
                <small>Its coverage must come from a tested app in QA Buddy.</small>
              </label>
              <label>
                <span>Framework</span>
                <select value={backend.framework} onChange={(event) => update(backend.key, { framework: event.target.value as SliceBackendFramework })}>
                  <option value="nestjs">NestJS</option>
                  <option value="express">Express</option>
                </select>
                <small>How routes are discovered.</small>
              </label>
              {backend.framework === "nestjs" ? (
                <>
                  <label>
                    <span>Generated client package</span>
                    <input value={backend.clientPackage} onChange={(event) => update(backend.key, { clientPackage: event.target.value })} placeholder="@acme/api-client" />
                    <small>The orval client frontends import endpoint calls from.</small>
                  </label>
                  <label>
                    <span>Root module</span>
                    <input value={backend.rootModule} onChange={(event) => update(backend.key, { rootModule: event.target.value })} placeholder="src/app.module.ts" />
                    <small>Relative to the workspace. Used to match operation ids exactly.</small>
                  </label>
                </>
              ) : (
                <label>
                  <span>Entry file</span>
                  <input value={backend.entryFile} onChange={(event) => update(backend.key, { entryFile: event.target.value })} placeholder="app.js" />
                  <small>The file that creates the Express app and mounts its routers.</small>
                </label>
              )}
              <label className={backend.framework === "express" ? "" : "field-span"}>
                <span>Base URL names</span>
                <input value={backend.baseUrlNames} onChange={(event) => update(backend.key, { baseUrlNames: event.target.value })} placeholder="VITE_API_HOST, apiHost" />
                <small>Variables or props frontends build this backend&apos;s URLs from. Comma separated.</small>
              </label>
            </div>
            {backends.length > 1 && (
              <button type="button" className="button button-ghost button-small" onClick={() => setBackends((current) => current.filter((candidate) => candidate.key !== backend.key))}>
                Remove backend
              </button>
            )}
          </fieldset>
        ))}
        <button type="button" className="button button-secondary button-small" onClick={() => setBackends((current) => [...current, toDraft({ directory: "", framework: "express", clientPackage: null, rootModule: null, entryFile: "app.js", baseUrlNames: [] })])}>
          <Icon name="plus" size={14} />Add backend
        </button>
        <label className="slice-frontends">
          <span>Frontends</span>
          <input value={frontends} onChange={(event) => setFrontends(event.target.value)} placeholder="Every apps/* workspace using a client package" />
          <small>Comma separated, for example apps/idinspect, apps/idcloud. Leave blank for every app that depends on a generated client.</small>
        </label>
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
      {reachedBackends(slice).length > 1 && (
        <ul className="slice-card-backends" aria-label="Coverage by backend">
          {reachedBackends(slice).map((backend) => {
            const backendValue = backend.coverage[metric];
            return (
              <li key={backend.directory}>
                <code>{backend.directory.split("/").at(-1)}</code>
                <span className="slice-backend-bar"><span className={`slice-backend-fill slice-percent-${coverageTone(backendValue?.percent)}`} style={{ width: `${backendValue?.percent ?? 0}%` }} /></span>
                <strong>{formatPercentValue(backendValue?.percent)}</strong>
              </li>
            );
          })}
        </ul>
      )}
      <dl className="slice-card-facts">
        <div><dt>Endpoints</dt><dd>{slice.endpointCount}</dd></div>
        <div><dt>Backend files</dt><dd>{slice.fileCount}</dd></div>
        <div><dt>Measured</dt><dd title="Slice files that appear in the latest coverage reports">{slice.measuredFileCount}</dd></div>
      </dl>
    </Link>
  );
}

/** Backends the slice calls; configured backends it never reaches are left out. */
export function reachedBackends<T extends { backends: Array<{ endpointCount: number }> }>(slice: T): T["backends"] {
  return slice.backends.filter((backend) => backend.endpointCount > 0);
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
