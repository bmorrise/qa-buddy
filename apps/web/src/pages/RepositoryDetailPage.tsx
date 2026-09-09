import { type FormEvent, useEffect, useState } from "react";
import type { RepositoryDetail, RunDetail } from "@qa-buddy/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { CoverageTable } from "../components/CoverageTable";
import { Loading } from "../components/Loading";
import { StatusBadge } from "../components/StatusBadge";
import { Icon } from "../components/Icon";

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

export function RepositoryDetailPage() {
  const { repositoryId = "" } = useParams();
  const navigate = useNavigate();
  const [repository, setRepository] = useState<RepositoryDetail | null>(null);
  const [ref, setRef] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedApps, setSelectedApps] = useState<string[]>([]);

  useEffect(() => {
    api<{ repository: RepositoryDetail }>(`/api/repositories/${repositoryId}`)
      .then(({ repository: result }) => {
        setRepository(result);
        setRef(result.defaultRef);
        setSelectedApps(result.selectableApps.map((app) => app.name));
      })
      .catch((caught: Error) => setError(caught.message));
  }, [repositoryId]);

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError("");
    try {
      const response = await api<{ run: RunDetail }>(`/api/repositories/${repositoryId}/runs`, {
        method: "POST",
        body: JSON.stringify({
          ref: ref.trim() || undefined,
          apps:
            repository && selectedApps.length < repository.selectableApps.length
              ? selectedApps
              : undefined
        })
      });
      navigate(`/runs/${response.run.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to start run");
      setRunning(false);
    }
  };

  const deleteRepository = async () => {
    if (!repository || !window.confirm(`Delete ${repository.name} and all retained run history?`)) return;
    try {
      await api(`/api/repositories/${repository.id}`, { method: "DELETE" });
      navigate("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete repository");
    }
  };

  if (error && !repository) return <div className="page"><div className="alert alert-error" role="alert">{error}</div></div>;
  if (!repository) return <Loading label="Loading repository…" />;

  const active = repository.runs.some((run) => ["queued", "cloning", "setup", "building", "testing"].includes(run.status));
  const selectableApps = repository.selectableApps;
  const latestStatus = new Map(repository.latestRun?.appRuns.map((app) => [app.name, app.status]) ?? []);
  const toggleApp = (name: string) => {
    setSelectedApps((current) =>
      current.includes(name) ? current.filter((candidate) => candidate !== name) : [...current, name]
    );
  };
  const selectFailedApps = () => {
    setSelectedApps(selectableApps.filter((app) => latestStatus.get(app.name) === "failed").map((app) => app.name));
  };

  return (
    <div className="page page-wide">
      <div className="breadcrumbs">
        <Link to="/repositories">Repositories</Link><span>/</span><span>{repository.name}</span>
      </div>
      <section className="page-heading repository-heading">
        <div>
          <span className="eyebrow">
            {repository.autoDetect
              ? "pnpm/Turborepo auto-detection"
              : `${repository.apps.length} configured app${repository.apps.length === 1 ? "" : "s"}`}
          </span>
          <h1>{repository.name}</h1>
          <a href={repository.githubUrl.replace(/\.git$/, "")} target="_blank" rel="noreferrer" className="repo-link">
            {repository.githubUrl.replace(/\.git$/, "")} ↗
          </a>
        </div>
        <div className="heading-actions">
          <Link to={`/repositories/${repository.id}/edit`} className="button button-secondary"><Icon name="settings" size={16} />Edit configuration</Link>
          <button type="button" className="button button-danger" onClick={deleteRepository}>Delete</button>
        </div>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <section className="run-launch panel accent-panel">
        <div>
          <span className="eyebrow">Manual run</span>
          <h2>Ready for a fresh run?</h2>
          <p>Choose the Git branch, tag, or commit to clone for this run. This does not change the saved default.</p>
        </div>
        <form onSubmit={startRun} className="run-form">
          <div className="run-form-controls">
            <label>
              <span>Test branch, tag, or commit SHA</span>
              <input
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                required
                aria-label="Test branch, tag, or commit SHA"
                placeholder={repository.defaultRef}
                autoComplete="off"
              />
              <small>Saved default: <code>{repository.defaultRef}</code></small>
            </label>
            <button className="button button-primary" disabled={running || active || (selectableApps.length > 0 && selectedApps.length === 0)}>
              <Icon name="play" size={14} />
              {running ? "Queueing…" : active ? "Run already active" : `Run ${selectedApps.length === selectableApps.length ? "all" : selectedApps.length} app${selectedApps.length === 1 ? "" : "s"} →`}
            </button>
          </div>
          {selectableApps.length > 1 && (
            <fieldset className="app-picker" aria-label="Choose applications">
              <div className="app-picker-heading">
                <strong>Choose applications</strong>
                <span>{selectedApps.length} of {selectableApps.length} selected</span>
                <button type="button" className="text-button" onClick={() => setSelectedApps(selectableApps.map((app) => app.name))}>Select all</button>
                <button type="button" className="text-button" onClick={() => setSelectedApps([])}>Unselect all</button>
                {[...latestStatus.values()].some((status) => status === "failed") && (
                  <button type="button" className="text-button danger" onClick={selectFailedApps}>Select failed</button>
                )}
              </div>
              <div className="app-picker-grid">
                {selectableApps.map((app) => (
                  <label key={app.name} className="app-picker-option">
                    <input type="checkbox" checked={selectedApps.includes(app.name)} onChange={() => toggleApp(app.name)} />
                    <span><strong>{app.name}</strong><small>{app.workingDirectory}{latestStatus.get(app.name) ? ` · ${latestStatus.get(app.name)}` : ""}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {repository.autoDetect && selectableApps.length === 0 && (
            <p className="app-picker-empty">Run all apps once to discover which applications can be selected individually.</p>
          )}
        </form>
      </section>

      {repository.latestRun && (
        <section className="panel detail-section">
          <div className="panel-heading">
            <div><span className="eyebrow">Latest result</span><h2>Coverage by app</h2></div>
            <div className="panel-heading-meta">
              <StatusBadge status={repository.latestRun.status} />
              <Link to={`/runs/${repository.latestRun.id}`}>Full run details →</Link>
            </div>
          </div>
          <CoverageTable appRuns={repository.latestRun.appRuns} />
        </section>
      )}

      <div className="detail-grid">
        <section className="panel detail-section">
          <div className="panel-heading"><div><span className="eyebrow">Configuration</span><h2>Runner setup</h2></div></div>
          <dl className="definition-list">
            <div><dt>Default test ref</dt><dd><code>{repository.defaultRef}</code></dd></div>
            <div><dt>Runner image</dt><dd><code>{repository.runnerImage}</code></dd></div>
            <div><dt>Setup command</dt><dd><code>{repository.setupCommand || "Not configured"}</code></dd></div>
            <div><dt>Build command override</dt><dd><code>{repository.buildCommand || "Not configured"}</code></dd></div>
            <div><dt>Test workers per app</dt><dd>{repository.testWorkerLimit}</dd></div>
            <div><dt>Timeout</dt><dd>{repository.timeoutMinutes} minutes</dd></div>
            <div><dt>App discovery</dt><dd>{repository.autoDetect ? "Automatic pnpm/Turborepo detection" : "Manual configuration"}</dd></div>
            <div><dt>Environment</dt><dd>{repository.environmentAllowlist.length ? repository.environmentAllowlist.join(", ") : "No variables passed"}</dd></div>
          </dl>
        </section>
        <section className="panel detail-section">
          <div className="panel-heading"><div><span className="eyebrow">Applications</span><h2>Test commands</h2></div></div>
          {repository.autoDetect ? (
            repository.latestRun?.appRuns.length ? (
              <div className="app-summary-list">
                {repository.latestRun.appRuns.map((app) => (
                  <div key={app.id}><strong>{app.name}</strong><code>{app.workingDirectory} · {app.testCommand}</code><small>Detected report: {app.coverageFormat} → {app.coveragePath}</small></div>
                ))}
              </div>
            ) : (
              <p className="empty-copy">Apps will be discovered from pnpm-workspace.yaml on the first run.</p>
            )
          ) : (
            <div className="app-summary-list">
              {repository.apps.map((app) => (
                <div key={app.id}><strong>{app.name}</strong><code>{app.workingDirectory} · {app.testCommand}</code><small>{app.coverageFormat} → {app.coveragePath}</small></div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel detail-section">
        <div className="panel-heading"><div><span className="eyebrow">Retained history</span><h2>Recent runs</h2></div><span className="muted">{repository.runs.length} retained runs</span></div>
        {repository.runs.length === 0 ? <p className="empty-copy">No runs yet. Start one above.</p> : (
          <div className="table-scroll"><table className="history-table"><thead><tr><th>Status</th><th>Ref</th><th>Commit</th><th>Apps</th><th>Started</th><th></th></tr></thead><tbody>
            {repository.runs.map((run) => <tr key={run.id}><td><StatusBadge status={run.status} /></td><td><code>{run.requestedRef}</code></td><td><code>{run.resolvedSha?.slice(0, 8) ?? "—"}</code></td><td>{run.selectedApps ? run.selectedApps.join(", ") : "All apps"}</td><td>{formatDate(run.startedAt ?? run.createdAt)}</td><td><Link to={`/runs/${run.id}`}>Details →</Link></td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}
