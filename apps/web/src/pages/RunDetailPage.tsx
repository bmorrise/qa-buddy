import { useEffect, useRef, useState } from "react";
import type { RunDetail } from "@qa-buddy/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { CoverageTable } from "../components/CoverageTable";
import { Loading } from "../components/Loading";
import { StatusBadge } from "../components/StatusBadge";
import { TestCaseReadout } from "../components/TestCaseReadout";
import { Icon } from "../components/Icon";

const terminal = ["passed", "failed", "timed_out", "interrupted"];
const maxLiveLogCharacters = 512_000;

function appendLiveLog(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= maxLiveLogCharacters) return next;
  return `[Older live output omitted; download the full log for complete output.]\n${next.slice(-maxLiveLogCharacters)}`;
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "—";
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [logs, setLogs] = useState("");
  const [loadError, setLoadError] = useState("");
  const [rerunError, setRerunError] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setRun(null);
    setLogs("");
    setLoadError("");
    setRerunError("");
    setRerunning(false);

    let cancelled = false;
    let source: EventSource | null = null;
    api<{ run: RunDetail }>(`/api/runs/${runId}`)
      .then(({ run: result }) => {
        if (cancelled) return;
        setRun(result);
        source = new EventSource(`/api/runs/${runId}/events`);
        source.addEventListener("log", (event) => {
          const data = JSON.parse((event as MessageEvent).data) as { chunk: string };
          setLogs((current) => appendLiveLog(current, data.chunk));
        });
        source.addEventListener("run", (event) => setRun(JSON.parse((event as MessageEvent).data) as RunDetail));
        source.addEventListener("complete", (event) => {
          setRun(JSON.parse((event as MessageEvent).data) as RunDetail);
          source?.close();
        });
      })
      .catch((caught: Error) => {
        if (!cancelled) setLoadError(caught.message);
      });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [runId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  if (loadError) return <div className="page"><div className="alert alert-error" role="alert">{loadError}</div></div>;
  if (!run) return <Loading label="Loading test run…" />;

  const isActive = !terminal.includes(run.status);
  const rerun = async () => {
    setRerunning(true);
    setRerunError("");
    try {
      const response = await api<{ run: RunDetail }>(`/api/repositories/${run.repositoryId}/runs`, {
        method: "POST",
        body: JSON.stringify({
          ref: run.requestedRef,
          apps: run.selectedApps ?? undefined
        })
      });
      navigate(`/runs/${response.run.id}`);
    } catch (caught) {
      setRerunError(caught instanceof Error ? caught.message : "Unable to queue the re-run");
      setRerunning(false);
    }
  };

  return (
    <div className="page page-wide">
      <div className="breadcrumbs"><Link to="/activity">Run history</Link><span>/</span><Link to={`/repositories/${run.repositoryId}`}>{run.configurationSnapshot.name}</Link><span>/</span><span>Run {run.id.slice(0, 8)}</span></div>
      <section className="page-heading run-heading">
        <div><span className="eyebrow">Test run · {run.id.slice(0, 8)}</span><h1>{run.configurationSnapshot.name}</h1><p>Ref <code>{run.requestedRef}</code>{run.resolvedSha && <> at <code>{run.resolvedSha.slice(0, 12)}</code></>} · {run.selectedApps ? <>Selected apps: <code>{run.selectedApps.join(", ")}</code></> : "All apps"}</p></div>
        <div className="heading-actions run-heading-actions">
          <StatusBadge status={run.status} />
          <button
            type="button"
            className="button button-primary"
            onClick={rerun}
            disabled={isActive || rerunning}
            title={isActive ? "Wait for this run to finish before running it again" : "Queue a fresh run with the same ref and app selection"}
          >
            <Icon name="play" size={14} />
            {rerunning ? "Queueing…" : "Re-run"}
          </button>
        </div>
      </section>

      {rerunError && <div className="alert alert-error" role="alert">{rerunError}</div>}
      {run.error && <div className="alert alert-error" role="alert">{run.error}</div>}

      <section className="run-stats">
        <div className="stat-card"><span>Created</span><strong>{formatDate(run.createdAt)}</strong></div>
        <div className="stat-card"><span>Started</span><strong>{formatDate(run.startedAt)}</strong></div>
        <div className="stat-card"><span>Finished</span><strong>{formatDate(run.finishedAt)}</strong></div>
        <div className="stat-card"><span>Runner</span><strong>{run.configurationSnapshot.runnerImage}</strong></div>
      </section>

      <section className="panel detail-section">
        <div className="panel-heading"><div><span className="eyebrow">App results</span><h2>Test and coverage readout</h2></div>{isActive && <span className="live-indicator"><i /> Live</span>}</div>
        <CoverageTable appRuns={run.appRuns} />
        {run.appRuns.some((app) => app.coverageError) && <div className="app-errors">{run.appRuns.filter((app) => app.coverageError).map((app) => <div key={app.id}><strong>{app.name}</strong><span>{app.coverageError}</span></div>)}</div>}
      </section>

      <section className="panel detail-section">
        <div className="panel-heading"><div><span className="eyebrow">Test cases</span><h2>Passed and failed tests</h2></div><span className="muted">Expand an app for exact results</span></div>
        <TestCaseReadout appRuns={run.appRuns} />
      </section>

      <section className="panel log-panel">
        <div className="panel-heading"><div><span className="eyebrow">Runner output</span><h2>{isActive ? "Live log" : "Run log"}</h2></div><div className="log-actions"><span className="muted">Secrets are redacted</span><a className="button button-secondary button-small" href={`/api/runs/${run.id}/log`} download><Icon name="download" size={14} />Download full log</a></div></div>
        <pre ref={logRef} aria-label="Run log">{logs || (isActive ? "Waiting for worker output…" : "No log output was recorded.")}</pre>
      </section>
    </div>
  );
}
