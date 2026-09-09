import { useState } from "react";
import type { AppRun, Repository } from "@qa-buddy/shared";
import { Link, useLocation } from "react-router-dom";
import { Icon, type IconName } from "../components/Icon";
import { Loading } from "../components/Loading";
import { StatusBadge } from "../components/StatusBadge";
import { activeStatuses, lineCoverage, needsAttention, relativeTime, runDuration, shortAppName, useWorkspace } from "../workspace";

function SummaryCard({ icon, label, value, detail, tone }: { icon: IconName; label: string; value: string; detail: string; tone: string }) {
  return <article className="summary-card"><div className="summary-label"><span>{label}</span><span className={`summary-icon ${tone}`}><Icon name={icon} size={17} /></span></div><strong className="summary-value">{value}</strong><span className="summary-detail">{detail}</span></article>;
}

function CoverageOverview({ apps }: { apps: AppRun[] }) {
  return <section className="panel coverage-overview"><div className="section-title"><h2>Coverage breakdown</h2><span className="subtle-label">Latest available reports</span></div><div className="coverage-overview-grid">{(["lines", "statements", "functions", "branches"] as const).map((name) => {
    const reports = apps.flatMap((app) => app.coverage?.[name] ? [app.coverage[name]] : []);
    const total = reports.reduce((sum, metric) => sum + metric.total, 0);
    const covered = reports.reduce((sum, metric) => sum + metric.covered, 0);
    const percent = total ? covered / total * 100 : null;
    return <div key={name}><span className="coverage-category">{name}</span><strong>{percent === null ? "—" : <>{percent.toFixed(1)}<small>%</small></>}</strong><span className="coverage-track"><span style={{width:`${percent ?? 0}%`}} /></span><small>{reports.length ? `${covered.toLocaleString()} of ${total.toLocaleString()}` : "No reports yet"}</small><span className="coverage-report-count">{reports.length} app {reports.length === 1 ? "report" : "reports"}</span></div>;
  })}</div></section>;
}

function RepositoryCard({ repository }: { repository: Repository }) {
  const run = repository.latestRun;
  return (
    <article className="repository-card panel">
      <header>
        <div className="repository-identity"><span className="repository-icon"><Icon name="repository" size={22} /></span><div><h2><Link to={`/repositories/${repository.id}`}>{repository.name}</Link></h2><a className="repo-url" href={repository.githubUrl.replace(/\.git$/, "")} target="_blank" rel="noreferrer">{repository.githubUrl.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "")}<Icon name="external" size={12} /></a></div></div>
        {run ? <StatusBadge status={run.status} /> : <span className="status status-neutral">Not run yet</span>}
      </header>
      <div className="repository-meta"><span><Icon name="branch" size={14} /><code>{run?.requestedRef ?? repository.defaultRef}</code></span><span><Icon name="layers" size={14} />{run ? `${run.appRuns.length} apps in latest run` : repository.autoDetect ? "Auto-detect apps" : `${repository.apps.length} configured apps`}</span>{repository.autoDetect && <span className="auto-detect-pill"><Icon name="sparkles" size={12} />Auto-detect</span>}</div>
      {run?.appRuns.length ? (
        <div className="table-scroll"><table className="repository-app-table"><thead><tr><th>Application</th><th>Tests</th><th>Line coverage</th><th>Status</th></tr></thead><tbody>
          {run.appRuns.map((app) => <tr key={app.id}><td><span className="app-name" title={app.name}><span className="app-dot" />{shortAppName(app.name)}</span></td><td>{app.testResults ? <span className="table-tests"><strong>{app.testResults.passed.toLocaleString()}</strong><span> / {app.testResults.total.toLocaleString()}</span></span> : <span className="metric-empty">—</span>}</td><td><div className="inline-coverage"><span className="coverage-track"><span style={{ width: `${app.coverage?.lines?.percent ?? 0}%` }} /></span><strong>{app.coverage?.lines?.percent == null ? "—" : `${app.coverage.lines.percent.toFixed(1)}%`}</strong></div></td><td><StatusBadge status={app.status} /></td></tr>)}
        </tbody></table></div>
      ) : <div className="not-run"><Icon name="terminal" /><div><strong>{run ? "Waiting for app results" : "Ready for your first run"}</strong><p>{run ? "App results will appear as the run progresses." : "Start a test run to see results and coverage here."}</p></div></div>}
      <div className="card-footer"><span><Icon name="clock" size={13} />{run ? <>Latest run <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>{relativeTime(run.createdAt)}</time></> : "No runs yet"}</span><Link to={`/repositories/${repository.id}`}>Open repository<Icon name="arrow" size={15} /></Link></div>
    </article>
  );
}

export function RepositoryListPage() {
  const { repositories, runs, error, historyError } = useWorkspace();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const overview = useLocation().pathname === "/";
  if (!repositories) return error ? <div className="page"><div className="alert alert-error" role="alert">{error}</div></div> : <Loading />;
  const apps = repositories.flatMap((repository) => repository.latestRun?.appRuns ?? []);
  const testReports = apps.flatMap((app) => app.testResults ? [app.testResults] : []);
  const passed = testReports.reduce((sum, result) => sum + result.passed, 0);
  const total = testReports.reduce((sum, result) => sum + result.total, 0);
  const coverage = lineCoverage(apps);
  const attention = repositories.filter(needsAttention).length;
  const noRuns = repositories.filter((repository) => !repository.latestRun).length;
  const active = repositories.filter((repository) => repository.latestRun && activeStatuses.includes(repository.latestRun.status)).length;
  const visible = repositories.filter((repository) => `${repository.name} ${repository.githubUrl}`.toLowerCase().includes(query.toLowerCase()) && (filter === "attention" ? needsAttention(repository) : filter === "new" ? !repository.latestRun : true));
  return (
    <div className="page page-wide dashboard-page">
      <section className="page-heading hero-heading"><div><span className="eyebrow">Your testing workspace</span><h1>{overview ? "A clearer view of quality." : "Your repositories."}</h1><p>{overview ? "Every repository, every test. A little more peace of mind." : "One place for your code, test results, and coverage."}</p></div><Link to="/repositories/new" className="button button-primary"><Icon name="plus" size={17} />Add repository</Link></section>
      {error && <div className="alert alert-error" role="alert">{error} Retrying shortly.</div>}
      <section className="summary-grid" aria-label="Workspace summary">
        <SummaryCard icon="repository" label="Repositories" value={String(repositories.length).padStart(2, "0")} detail={`${repositories.filter((repository) => repository.latestRun?.status === "passed").length} with a passing latest run`} tone="violet" />
        <SummaryCard icon="layers" label="Applications" value={String(apps.length).padStart(2, "0")} detail="Included in the latest repository runs" tone="blue" />
        <SummaryCard icon="checkCircle" label="Tests passed" value={testReports.length ? passed.toLocaleString() : "—"} detail={testReports.length ? `Out of ${total.toLocaleString()} reported tests in latest runs` : "Results appear after your first run"} tone="green" />
        <SummaryCard icon="coverage" label="Line coverage" value={coverage == null ? "—" : `${coverage.toFixed(1)}%`} detail="Weighted across available latest reports" tone="amber" />
      </section>
      <div className={`dashboard-grid ${overview ? "" : "repositories-only"}`}>
        <section className="repositories-section" aria-label="Repositories">
          <div className="section-title"><h2>Repositories <span className="count-badge">{repositories.length}</span></h2><span className="subtle-label">Your connected codebases</span></div>
          <div className="repository-toolbar"><div className="filter-tabs" aria-label="Filter repositories">{[{id:"all",label:"All repositories",count:repositories.length},{id:"attention",label:"Needs attention",count:attention},{id:"new",label:"No runs yet",count:noRuns}].map((tab) => <button type="button" key={tab.id} className={filter === tab.id ? "selected" : ""} onClick={() => setFilter(tab.id)} aria-pressed={filter === tab.id}>{tab.label}<span>{tab.count}</span></button>)}</div><label className="search-field"><Icon name="search" size={16} /><input type="search" aria-label="Search repositories" placeholder="Find a repository…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
          {repositories.length === 0 ? <div className="empty-state panel"><div className="empty-icon"><Icon name="repository" size={26} /></div><h2>Good tests start here.</h2><p>Connect a GitHub repository to bring your tests, coverage, and run history together.</p><Link to="/repositories/new" className="button button-primary"><Icon name="plus" />Add your first repository</Link></div> : visible.length ? <div className="repository-grid">{visible.map((repository) => <RepositoryCard key={repository.id} repository={repository} />)}</div> : <div className="empty-state panel"><div className="empty-icon"><Icon name="search" size={24} /></div><h2>{query ? "No matching repositories" : filter === "attention" ? "Looking good." : "All repositories have run."}</h2><p>{query ? "Try another name or clear your filters." : filter === "attention" ? "None of your latest repository runs need attention." : "Your connected repositories already have test results."}</p><button className="button button-secondary" onClick={() => { setQuery(""); setFilter("all"); }}>Show all repositories</button></div>}
          {overview && apps.some((app) => app.coverage) && <CoverageOverview apps={apps} />}
          <div className="workspace-caption"><Icon name="shield" size={14} /><span>Fresh checkouts. Isolated runners. Results you can come back to.</span></div>
        </section>
        {overview && <aside className="dashboard-aside">
          <section className="panel activity-panel"><div className="section-title"><h2>Recent activity</h2><Icon name="activity" size={18} /></div>{historyError && <p className="inline-error" role="alert">{historyError}</p>}{runs === null ? <p className="empty-copy">Loading recent runs…</p> : runs.length ? <div className="activity-list">{runs.slice(0, 4).map((run) => <Link to={`/runs/${run.id}`} className="activity-item" key={run.id}><span className={`activity-icon activity-${run.status}`}><Icon name={run.status === "passed" ? "check" : activeStatuses.includes(run.status) ? "activity" : "close"} size={14} /></span><div><div className="activity-item-heading"><strong>{run.repositoryName}</strong><Icon name="chevron" size={12} /></div><span className="activity-ref"><Icon name="branch" size={12} /><code>{run.requestedRef}</code></span><div className="activity-item-meta"><StatusBadge status={run.status} /><time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>{relativeTime(run.createdAt)} · {runDuration(run)}</time></div></div></Link>)}</div> : <div className="activity-empty"><Icon name="clock" size={26} /><strong>Your story starts with a run.</strong><p>Recent test runs will appear here.</p></div>}<Link className="activity-all" to="/activity">View run history<Icon name="arrow" size={15} /></Link></section>
          <section className="workspace-insight"><span className="insight-icon"><Icon name={attention ? "activity" : active ? "play" : "sparkles"} size={21} /></span><span className="eyebrow">At a glance</span><h3>{attention ? `${attention} ${attention === 1 ? "repository needs" : "repositories need"} a closer look.` : active ? "Tests are in motion." : repositories.length && !noRuns ? "All quiet. All green." : "Ready when you are."}</h3><p>{attention ? "Open the latest results to see what needs your attention." : active ? `${active} ${active === 1 ? "repository has" : "repositories have"} a run in progress. Results refresh automatically.` : repositories.length && !noRuns ? "Your latest repository runs passed. Keep building with confidence." : "Connect your code and run your tests. We’ll keep the results organized."}</p><span className="insight-footer"><i />{active ? "Runs in progress" : "Manual runs · Your schedule"}</span></section>
        </aside>}
      </div>
    </div>
  );
}
