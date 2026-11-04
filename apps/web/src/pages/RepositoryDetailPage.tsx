import { type FormEvent, useEffect, useState } from "react";
import {
  activeRunStatuses,
  shortAppName,
  type AppGroup,
  type RepositoryDetail,
  type RunDetail,
  type RunSummary
} from "@qa-buddy/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { CoverageTable } from "../components/CoverageTable";
import { CoverageTrends } from "../components/CoverageTrends";
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
  const [useLocalWorkingTree, setUseLocalWorkingTree] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [appFilter, setAppFilter] = useState("");
  const [namingGroup, setNamingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [appliedGroupId, setAppliedGroupId] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);

  useEffect(() => {
    api<{ repository: RepositoryDetail }>(`/api/repositories/${repositoryId}`)
      .then(({ repository: result }) => {
        setRepository(result);
        setRef(result.defaultRef);
        setSelectedApps(result.selectableApps.map((app) => app.name));
      })
      .catch((caught: Error) => setError(caught.message));
  }, [repositoryId]);

  const activeRun: RunSummary | undefined = repository?.runs.find((candidate) =>
    activeRunStatuses.includes(candidate.status)
  );
  const activeRunId = activeRun?.id;

  useEffect(() => {
    if (!activeRunId) return;
    const interval = setInterval(() => {
      api<{ repository: RepositoryDetail }>(`/api/repositories/${repositoryId}`)
        .then(({ repository: result }) => setRepository(result))
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(interval);
  }, [activeRunId, repositoryId]);

  const stopActiveRun = async () => {
    if (!activeRunId) return;
    if (!window.confirm("Stop this run? Applications that have not finished are marked skipped.")) return;
    setStopping(true);
    setError("");
    try {
      await api(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to stop this run");
    } finally {
      setStopping(false);
    }
  };


  const refreshRepository = async (): Promise<void> => {
    const { repository: result } = await api<{ repository: RepositoryDetail }>(
      `/api/repositories/${repositoryId}`
    );
    setRepository(result);
  };

  const saveGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupName.trim()) return;
    setGroupBusy(true);
    setError("");
    try {
      const { appGroup } = await api<{ appGroup: AppGroup }>(
        `/api/repositories/${repositoryId}/app-groups`,
        { method: "POST", body: JSON.stringify({ name: groupName.trim(), appNames: selectedApps }) }
      );
      await refreshRepository();
      setAppliedGroupId(appGroup.id);
      setNamingGroup(false);
      setGroupName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the group");
    } finally {
      setGroupBusy(false);
    }
  };

  const updateGroup = async (group: AppGroup, changes: { name?: string; appNames?: string[] }) => {
    setGroupBusy(true);
    setError("");
    try {
      await api(`/api/app-groups/${group.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      await refreshRepository();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update the group");
    } finally {
      setGroupBusy(false);
    }
  };

  const moveGroup = async (index: number, offset: -1 | 1) => {
    if (!repository) return;
    const groupIds = repository.appGroups.map((group) => group.id);
    [groupIds[index], groupIds[index + offset]] = [groupIds[index + offset]!, groupIds[index]!];
    setGroupBusy(true);
    setError("");
    try {
      await api(`/api/repositories/${repository.id}/app-groups/order`, { method: "PUT", body: JSON.stringify({ groupIds }) });
      await refreshRepository();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reorder the groups");
    } finally {
      setGroupBusy(false);
    }
  };

  const renameGroup = async (group: AppGroup) => {
    const name = window.prompt(`Rename "${group.name}" to:`, group.name);
    if (!name || name.trim() === group.name) return;
    await updateGroup(group, { name: name.trim() });
  };

  const deleteGroup = async (group: AppGroup) => {
    if (!window.confirm(`Delete the group "${group.name}"? The applications themselves are not affected.`)) return;
    setGroupBusy(true);
    setError("");
    try {
      await api(`/api/app-groups/${group.id}`, { method: "DELETE" });
      if (appliedGroupId === group.id) setAppliedGroupId(null);
      await refreshRepository();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete the group");
    } finally {
      setGroupBusy(false);
    }
  };

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError("");
    try {
      const response = await api<{ run: RunDetail }>(`/api/repositories/${repositoryId}/runs`, {
        method: "POST",
        body: JSON.stringify({
          ref: ref.trim() || undefined,
          useLocalWorkingTree: useLocalWorkingTree || undefined,
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

  const active = Boolean(activeRun);
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

  const selectableNames = new Set(selectableApps.map((app) => app.name));
  const filterTerm = appFilter.trim().toLocaleLowerCase();
  // Matching the working directory as well as the name matters here: package
  // names share a scope prefix, so the path is often the distinguishing part.
  const visibleApps = filterTerm
    ? selectableApps.filter(
        (app) =>
          app.name.toLocaleLowerCase().includes(filterTerm) ||
          app.workingDirectory.toLocaleLowerCase().includes(filterTerm)
      )
    : selectableApps;
  const visibleNames = new Set(visibleApps.map((app) => app.name));
  const hiddenSelectedCount = selectedApps.filter((name) => !visibleNames.has(name)).length;

  /** A group only ever selects apps that still exist in this repository. */
  const resolveGroup = (group: AppGroup): string[] =>
    group.appNames.filter((name) => selectableNames.has(name));
  const sameSelection = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every((name) => right.includes(name));
  const appliedGroup = repository.appGroups.find((group) => group.id === appliedGroupId) ?? null;
  const appliedGroupDrifted = Boolean(
    appliedGroup && !sameSelection(resolveGroup(appliedGroup), selectedApps)
  );

  const applyGroup = (group: AppGroup) => {
    setSelectedApps(resolveGroup(group));
    setAppliedGroupId(group.id);
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
          <Link to={`/repositories/${repository.id}/coverage`} className="button button-secondary"><Icon name="coverage" size={16} />Coverage gaps</Link>
          <Link to={`/repositories/${repository.id}/slices`} className="button button-secondary"><span aria-hidden="true">🍕</span>Slices</Link>
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
            <label className={useLocalWorkingTree ? "field-disabled" : undefined}>
              <span>Test branch, tag, or commit SHA</span>
              <input
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                aria-label="Test branch, tag, or commit SHA"
                placeholder={repository.defaultRef}
                autoComplete="off"
                disabled={useLocalWorkingTree}
              />
              <small>
                {useLocalWorkingTree
                  ? "Ignored while running against the local working tree."
                  : <>Saved default: <code>{repository.defaultRef}</code></>}
              </small>
            </label>
            {activeRun && (
              <button
                type="button"
                className="button button-danger"
                onClick={stopActiveRun}
                disabled={stopping || activeRun.cancelRequested}
                title="Stop the run in progress without marking it as failed"
              >
                <Icon name="close" size={14} />
                {activeRun.cancelRequested || stopping ? "Stopping…" : "Stop run"}
              </button>
            )}
            <button className="button button-primary" disabled={running || active || (selectableApps.length > 0 && selectedApps.length === 0)}>
              <Icon name="play" size={14} />
              {running ? "Queueing…" : active ? "Run already active" : `Run ${selectedApps.length === selectableApps.length ? "all" : selectedApps.length} app${selectedApps.length === 1 ? "" : "s"} →`}
            </button>
          </div>
          {repository.localPath && (
            <label className="local-source-toggle">
              <input
                type="checkbox"
                checked={useLocalWorkingTree}
                onChange={(event) => setUseLocalWorkingTree(event.target.checked)}
              />
              <span>
                <strong>
                  Run against my local working tree (<code>{repository.localPath}</code>)
                </strong>
                <small>
                  Archives your checkout at <code>HEAD</code> plus uncommitted changes. Gitignored files such as{" "}
                  <code>.env</code> are never included, and the result is not reproducible from a commit alone.
                </small>
              </span>
            </label>
          )}
          {selectableApps.length > 1 && (
            <fieldset className="app-picker" aria-label="Choose applications">
              <div className="app-picker-heading">
                <strong>Choose applications</strong>
                <span>{selectedApps.length} of {selectableApps.length} selected</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setSelectedApps((current) =>
                      Array.from(new Set([...current, ...visibleApps.map((app) => app.name)]))
                    )
                  }
                >
                  {filterTerm ? `Select all ${visibleApps.length} matching` : "Select all"}
                </button>
                <button type="button" className="text-button" onClick={() => setSelectedApps([])}>Unselect all</button>
                {[...latestStatus.values()].some((status) => status === "failed") && (
                  <button type="button" className="text-button danger" onClick={selectFailedApps}>Select failed</button>
                )}
              </div>

              {repository.appGroups.length > 0 && (
                <div className="app-group-row">
                  <span className="app-group-label">Groups</span>
                  {repository.appGroups.map((group, index) => {
                    const resolved = resolveGroup(group);
                    const missing = group.appNames.length - resolved.length;
                    const isApplied = group.id === appliedGroupId;
                    return (
                      <span key={group.id} className={isApplied ? "app-group-chip applied" : "app-group-chip"}>
                        <button type="button" className="app-group-apply" onClick={() => applyGroup(group)}>
                          {group.name}
                          <small>
                            {resolved.length} app{resolved.length === 1 ? "" : "s"}
                            {missing > 0 ? ` · ${missing} no longer detected` : ""}
                          </small>
                        </button>
                        <span className="app-group-actions">
                          <span>
                            {isApplied && appliedGroupDrifted && (
                              <button
                                type="button"
                                className="text-button app-group-action"
                                disabled={groupBusy || selectedApps.length === 0}
                                title="Replace this group's apps with the current selection"
                                onClick={() => updateGroup(group, { appNames: selectedApps })}
                              >
                                Update
                              </button>
                            )}
                            <button
                              type="button"
                              className="text-button app-group-action"
                              disabled={groupBusy}
                              onClick={() => renameGroup(group)}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="text-button danger app-group-action"
                              disabled={groupBusy}
                              onClick={() => deleteGroup(group)}
                            >
                              Delete
                            </button>
                          </span>
                          {repository.appGroups.length > 1 && (
                            <span className="app-group-move">
                              <button
                                type="button"
                                className="text-button app-group-action"
                                aria-label={`Move ${group.name} earlier`}
                                title="Move earlier"
                                disabled={groupBusy || index === 0}
                                onClick={() => moveGroup(index, -1)}
                              >
                                ←
                              </button>
                              <button
                                type="button"
                                className="text-button app-group-action"
                                aria-label={`Move ${group.name} later`}
                                title="Move later"
                                disabled={groupBusy || index === repository.appGroups.length - 1}
                                onClick={() => moveGroup(index, 1)}
                              >
                                →
                              </button>
                            </span>
                          )}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="app-picker-tools">
                <input
                  type="search"
                  className="app-filter"
                  value={appFilter}
                  onChange={(event) => setAppFilter(event.target.value)}
                  placeholder="Filter by name or path, for example libs/ or riverside"
                  aria-label="Filter applications"
                  autoComplete="off"
                />
                {namingGroup ? (
                  <span className="app-group-save">
                    <input
                      value={groupName}
                      onChange={(event) => setGroupName(event.target.value)}
                      placeholder="Group name"
                      aria-label="Group name"
                      autoComplete="off"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setNamingGroup(false);
                          setGroupName("");
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={groupBusy || !groupName.trim()}
                      onClick={saveGroup}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setNamingGroup(false);
                        setGroupName("");
                      }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    disabled={selectedApps.length === 0}
                    title={
                      selectedApps.length === 0
                        ? "Select the applications you want to save first"
                        : "Save the current selection as a reusable group"
                    }
                    onClick={() => setNamingGroup(true)}
                  >
                    Save selection as group
                  </button>
                )}
              </div>
              {namingGroup && (
                <p className="app-group-hint">
                  Naming {selectedApps.length} app{selectedApps.length === 1 ? "" : "s"}:{" "}
                  {selectedApps.map((name) => shortAppName(name)).join(", ")}
                </p>
              )}
              {hiddenSelectedCount > 0 && (
                <p className="app-picker-warning">
                  {hiddenSelectedCount} selected app{hiddenSelectedCount === 1 ? " is" : "s are"} hidden by the
                  current filter and will still run.
                </p>
              )}

              <div className="app-picker-grid">
                {visibleApps.map((app) => (
                  <label key={app.name} className="app-picker-option">
                    <input type="checkbox" checked={selectedApps.includes(app.name)} onChange={() => toggleApp(app.name)} />
                    <span><strong>{shortAppName(app.name)}</strong><small>{app.workingDirectory}{latestStatus.get(app.name) ? ` · ${latestStatus.get(app.name)}` : ""}</small></span>
                  </label>
                ))}
              </div>
              {visibleApps.length === 0 && (
                <p className="empty-copy">No applications match this filter.</p>
              )}
            </fieldset>
          )}
          {repository.autoDetect && selectableApps.length === 0 && (
            <p className="app-picker-empty">Run all apps once to discover which applications can be selected individually.</p>
          )}
        </form>
      </section>

      <CoverageTrends repositoryId={repository.id} repositoryName={repository.name} groups={repository.appGroups} goal={repository.coverageGoal} refreshKey={repository.latestCompletedRun?.id ?? null} />

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
            {repository.runs.map((run) => <tr key={run.id}><td><StatusBadge status={run.status} /></td><td><code>{run.useLocalWorkingTree ? "local working tree" : run.requestedRef}</code></td><td><code>{run.resolvedSha?.slice(0, 8) ?? "—"}{run.dirty ? "+dirty" : ""}</code></td><td>{run.selectedApps ? run.selectedApps.join(", ") : "All apps"}</td><td>{formatDate(run.startedAt ?? run.createdAt)}</td><td><Link to={`/runs/${run.id}`}>Details →</Link></td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}
