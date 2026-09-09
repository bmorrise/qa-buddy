import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Loading";
import { StatusBadge } from "../components/StatusBadge";
import { activeStatuses, relativeTime, runDuration, useWorkspace } from "../workspace";

export function RunHistoryPage() {
  const { repositories, runs, error, historyError } = useWorkspace();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  if (!repositories) return error ? <div className="page"><div className="alert alert-error" role="alert">{error}</div></div> : <Loading label="Loading run history…" />;
  const visible = runs?.filter((run) => `${run.repositoryName} ${run.requestedRef} ${run.resolvedSha ?? ""}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "active" ? activeStatuses.includes(run.status) : filter === "failed" ? ["failed", "timed_out", "interrupted"].includes(run.status) : run.status === filter)));
  return (
    <div className="page page-wide">
      <section className="page-heading"><div><span className="eyebrow">Every run tells a story</span><h1>Run history.</h1><p>Follow the results, revisit the details, and see how your code is doing.</p></div><Link to="/repositories" className="button button-secondary"><Icon name="repository" size={17} />View repositories</Link></section>
      {(error || historyError) && <div className="alert alert-error" role="alert">{error || historyError}</div>}
      <div className="repository-toolbar history-toolbar"><div className="filter-tabs" aria-label="Filter runs">{[{id:"all",label:"All runs"},{id:"passed",label:"Passed"},{id:"failed",label:"Needs attention"},{id:"active",label:"Active"}].map((tab) => <button key={tab.id} className={filter === tab.id ? "selected" : ""} aria-pressed={filter === tab.id} onClick={() => setFilter(tab.id)}>{tab.label}</button>)}</div><label className="search-field"><Icon name="search" size={16} /><input type="search" aria-label="Search run history" placeholder="Find a repository or ref…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
      <section className="panel detail-section history-panel">
        {visible?.length ? <div className="table-scroll"><table className="history-table all-runs-table"><thead><tr><th>Repository / run</th><th>Status</th><th>Branch / ref</th><th>Applications</th><th>Duration</th><th>Created</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{visible.map((run) => <tr key={run.id}><td><Link className="run-name" to={`/runs/${run.id}`}>{run.repositoryName}</Link><small className="cell-subtitle">{run.id.slice(0,8)}</small></td><td><StatusBadge status={run.status} /></td><td><code>{run.requestedRef}</code><small className="cell-subtitle">{run.resolvedSha?.slice(0,8) ?? "Commit not resolved"}</small></td><td>{run.appRuns.length || "—"}</td><td className="nowrap">{runDuration(run)}</td><td className="nowrap"><time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>{relativeTime(run.createdAt)}</time></td><td><Link className="icon-button" to={`/runs/${run.id}`} aria-label={`View run ${run.id.slice(0,8)}`}><Icon name="arrow" size={17} /></Link></td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={25} /></div><h2>{runs === null ? "Loading your history…" : runs.length ? "No matching runs" : "A fresh start."}</h2><p>{runs === null ? "Gathering results from your repositories." : runs.length ? "Try another search or choose a different status." : "Start a run from a repository to see its results here."}</p>{runs?.length ? <button className="button button-secondary" onClick={() => {setQuery("");setFilter("all");}}>Clear filters</button> : <Link className="button button-primary" to="/repositories">View repositories<Icon name="arrow" size={16} /></Link>}</div>}
      </section>
      <p className="history-note">Showing {visible?.length ?? 0} retained runs across {repositories.length} {repositories.length === 1 ? "repository" : "repositories"}. Updates every 30 seconds.</p>
    </div>
  );
}
