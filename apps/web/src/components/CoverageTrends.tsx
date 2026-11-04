import { type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction, useEffect, useRef, useState } from "react";
import {
  buildCoverageTrend,
  shortAppName,
  sliceTrend,
  type AppGroup,
  type CoverageHistoryEntry,
  type CoverageTrend,
  type CoverageTrendMetric
} from "@qa-buddy/shared";
import { api } from "../api";
import { Icon } from "./Icon";
import { buildTrendExportSvg, downloadPng, downloadSvg, exportFileName } from "./trend-export";
import { chartLayout, formatDelta, formatPercent, linePath, longDate, metricHeading, metricLabels, shortDate, summarizeTrend } from "./trend-model";

export { formatDateRange, formatSpan } from "./trend-model";

const metricOrder: CoverageTrendMetric[] = ["branches", "functions", "lines", "statements"];
/** Combined views, kept visually apart from the real metrics. */
const combinedMetrics: CoverageTrendMetric[] = ["max", "min"];
const metricTitles: Record<CoverageTrendMetric, string> = {
  branches: "Share of decision paths taken, such as both sides of an if/else or each switch case. Usually the strictest measure.",
  functions: "Share of functions and methods called at least once.",
  lines: "Share of executable source lines run at least once.",
  statements: "Share of statements executed. Close to lines, but counts each statement when several share a line.",
  max: "Each app's highest of the four metrics, weighted by line count. Optimistic by design.",
  min: "Each app's lowest of the four metrics, weighted by line count. Pessimistic by design."
};
const ranges = [
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All", days: null }
] as const;
type RangeId = (typeof ranges)[number]["id"];
const height = 260;
const margin = { top: 14, right: 64, bottom: 30, left: 44 };

function TrendChart({
  trend,
  metric,
  goal,
  focusedApp,
  setFocusedApp
}: {
  trend: CoverageTrend;
  metric: CoverageTrendMetric;
  goal: number | null;
  focusedApp: string | null;
  setFocusedApp: Dispatch<SetStateAction<string | null>>;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const element = wrapper.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { points, apps } = trend;
  const { totals, domain, plotWidth, plotHeight, step, x, y, labelIndexes, labelAnchor, lastTotalIndex, colored, appColor } =
    chartLayout(trend, goal, width, height, margin);
  const isDimmed = (appName: string) => focusedApp !== null && focusedApp !== appName;

  const pointerIndex = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left;
    return points.length > 1 ? Math.min(points.length - 1, Math.max(0, Math.round(offset / step))) : 0;
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = hovered ?? (event.key === "ArrowLeft" ? points.length : -1);
    setHovered(Math.min(points.length - 1, Math.max(0, current + (event.key === "ArrowRight" ? 1 : -1))));
  };

  const active = hovered === null ? null : points[hovered]!;
  const tooltipApps =
    hovered === null
      ? []
      : apps
          .map((app, index) => ({ app, index, value: app.values[hovered] ?? null, source: app.sources[hovered] ?? null }))
          .filter(({ app, value }) => value !== null && (colored || app.appName === focusedApp));

  return (
    <div className="trend-chart" ref={wrapper}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${metricLabels[metric]} coverage over ${points.length} completed runs. Use the arrow keys to step through runs.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setHovered(null)}
      >
        {domain.ticks.map((tick) => (
          <g key={tick}>
            <line className="trend-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
            <text className="trend-axis" x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{tick}%</text>
          </g>
        ))}
        {labelIndexes.map((index) => (
          <text key={index} className="trend-axis" x={x(index)} y={height - 8} textAnchor={labelAnchor(index)}>
            {shortDate(points[index]!.recordedAt)}
          </text>
        ))}
        {goal !== null && (
          <g className="trend-goal">
            <line x1={margin.left} x2={width - margin.right} y1={y(goal)} y2={y(goal)} />
            <text x={margin.left + 6} y={y(goal) - 6}>Goal {goal}%</text>
          </g>
        )}
        {apps.map((app, index) => (
          <path
            key={app.appName}
            className={`trend-line ${colored ? "" : "trend-line-muted"} ${isDimmed(app.appName) ? "trend-line-dimmed" : ""}`}
            d={linePath(app.values, x, y)}
            stroke={appColor(index)}
          />
        ))}
        {!colored && focusedApp && apps.filter((app) => app.appName === focusedApp).map((app) => (
          <path key={app.appName} className="trend-line trend-line-focused" d={linePath(app.values, x, y)} />
        ))}
        <path className="trend-line trend-line-total" d={linePath(totals, x, y)} />
        {totals.map((value, index) => value !== null && (
          <circle key={index} className="trend-total-dot" cx={x(index)} cy={y(value)} r={points.length > 40 ? 0 : 3} />
        ))}
        {lastTotalIndex < totals.length && (
          <text className="trend-direct-label" x={x(lastTotalIndex) + 8} y={y(totals[lastTotalIndex]!)} dy="0.32em">
            Total
          </text>
        )}
        {active && hovered !== null && (
          <g className="trend-hover" aria-hidden="true">
            <line className="trend-crosshair" x1={x(hovered)} x2={x(hovered)} y1={margin.top} y2={margin.top + plotHeight} />
            {tooltipApps.map(({ app, index, value }) => (
              <circle key={app.appName} cx={x(hovered)} cy={y(value!)} r={4} fill={colored ? appColor(index) : "var(--accent)"} />
            ))}
            {active.total?.percent != null && <circle cx={x(hovered)} cy={y(active.total.percent)} r={5} fill="var(--text)" />}
          </g>
        )}
        <rect
          className="trend-hit"
          x={margin.left - Math.max(step / 2, 12)}
          y={margin.top}
          width={plotWidth + Math.max(step, 24)}
          height={plotHeight}
          onPointerMove={(event) => setHovered(pointerIndex(event))}
          onPointerLeave={() => setHovered(null)}
        />
      </svg>
      {active && hovered !== null && (
        <div
          className="trend-tooltip"
          style={x(hovered) > width / 2 ? { right: width - x(hovered) + 12 } : { left: x(hovered) + 12 }}
          role="status"
        >
          <span className="trend-tooltip-date">{longDate(active.recordedAt)}</span>
          <span className="trend-tooltip-ref"><code>{active.useLocalWorkingTree ? "local working tree" : active.requestedRef}</code>{active.resolvedSha ? <code> · {active.resolvedSha.slice(0, 8)}{active.dirty ? "+dirty" : ""}</code> : null}</span>
          <span className="trend-tooltip-row trend-tooltip-total"><i style={{ background: "var(--text)" }} /><strong>{formatPercent(active.total?.percent)}</strong><span>Total</span></span>
          {tooltipApps.map(({ app, index, value, source }) => (
            <span key={app.appName} className="trend-tooltip-row"><i style={{ background: colored ? appColor(index) : "var(--accent)" }} /><strong>{formatPercent(value)}</strong><span title={app.appName}>{shortAppName(app.appName)}{source && source !== metric ? ` (${source})` : ""}{active.ranApps.some((name) => name.toLowerCase() === app.appName.toLowerCase()) ? "" : " (carried forward)"}</span></span>
          ))}
          <span className="trend-tooltip-foot">
            {active.testsTotal === null ? "No test counts" : `${active.testsTotal.toLocaleString()} tests`} · {active.ranApps.length} of {apps.length} {apps.length === 1 ? "app" : "apps"} ran
          </span>
        </div>
      )}
      <div className="trend-legend" aria-label="Chart legend">
        <span className="trend-legend-item trend-legend-total"><i style={{ background: "var(--text)" }} />Weighted total</span>
        {apps.map((app, index) => (
          <button
            type="button"
            key={app.appName}
            className={`trend-legend-item ${focusedApp === app.appName ? "selected" : ""} ${isDimmed(app.appName) ? "dimmed" : ""}`}
            aria-pressed={focusedApp === app.appName}
            title={app.appName}
            onClick={() => setFocusedApp((current) => (current === app.appName ? null : app.appName))}
          >
            <i style={{ background: colored ? appColor(index) : focusedApp === app.appName ? "var(--accent)" : "#b9bac7" }} />
            {shortAppName(app.appName)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A tab that narrows the chart to some of the series. */
export type TrendScope = Pick<AppGroup, "id" | "name" | "appNames">;

export function CoverageTrends({
  repositoryId,
  repositoryName = "Repository",
  groups,
  refreshKey,
  goal = null,
  historyPath,
  includeAllTab = true,
  eyebrow = "Completed runs",
  title = "Coverage trend",
  scopeLabel = "Application group"
}: {
  repositoryId: string;
  repositoryName?: string;
  groups: TrendScope[];
  refreshKey: string | null;
  goal?: number | null;
  /** History endpoint; defaults to the repository's app coverage history. */
  historyPath?: string;
  /**
   * Whether to offer an "All" tab. Slices overlap, so a weighted total across
   * them would count shared files more than once; they pass false.
   */
  includeAllTab?: boolean;
  eyebrow?: string;
  title?: string;
  scopeLabel?: string;
}) {
  const [entries, setEntries] = useState<CoverageHistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<CoverageTrendMetric>("branches");
  const [selectedGroupId, setGroupId] = useState<string | null>(null);
  const groupId = includeAllTab || groups.some((candidate) => candidate.id === selectedGroupId)
    ? selectedGroupId
    : groups[0]?.id ?? null;
  const [rangeId, setRangeId] = useState<RangeId>("all");
  const [focusedApp, setFocusedApp] = useState<string | null>(null);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ entries: CoverageHistoryEntry[] }>(historyPath ?? `/api/repositories/${repositoryId}/coverage/history`)
      .then(({ entries: result }) => {
        if (cancelled) return;
        setEntries(result);
        setError("");
      })
      .catch((caught: Error) => !cancelled && setError(caught.message));
    return () => { cancelled = true; };
  }, [repositoryId, refreshKey, historyPath]);

  const group = groups.find((candidate) => candidate.id === groupId) ?? null;
  const range = ranges.find((candidate) => candidate.id === rangeId)!;
  const since = range.days === null ? null : new Date(Date.now() - range.days * 86_400_000).toISOString();
  const trend = entries ? sliceTrend(buildCoverageTrend(entries, metric, group?.appNames ?? null), since) : null;
  const scopeName = group?.name ?? "All apps";
  const summary = trend && trend.points.length ? summarizeTrend(trend, metric, scopeName, goal) : null;
  const visibleFocus = focusedApp && trend?.apps.some((app) => app.appName === focusedApp) ? focusedApp : null;

  const exportChart = async (format: "svg" | "png") => {
    if (!trend || !summary) return;
    setExportError("");
    const generatedAt = new Date();
    const subtitle = `${metricHeading(metric)} · ${scopeName} · ${range.days === null ? "All history" : `Last ${range.label}`}`;
    const svg = buildTrendExportSvg({ repositoryName, subtitle, trend, summary, goal, focusedApp: visibleFocus, generatedAt });
    try {
      if (format === "svg") downloadSvg(svg, exportFileName(repositoryName, subtitle, generatedAt, "svg"));
      else await downloadPng(svg, exportFileName(repositoryName, subtitle, generatedAt, "png"));
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Unable to export the chart");
    }
  };

  return (
    <section className="panel detail-section coverage-trends">
      <div className="panel-heading">
        <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
        <div className="trend-controls">
        <div className="filter-tabs" role="group" aria-label="Time range">
          {ranges.map((option) => (
            <button type="button" key={option.id} className={rangeId === option.id ? "selected" : ""} aria-pressed={rangeId === option.id} onClick={() => setRangeId(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        <div className="filter-tabs" role="group" aria-label="Coverage metric">
          {[...metricOrder, ...combinedMetrics].map((name) => (
            <button
              type="button"
              key={name}
              className={`${metric === name ? "selected" : ""} ${name === combinedMetrics[0] ? "trend-metric-combined-start" : ""}`}
              aria-pressed={metric === name}
              title={metricTitles[name]}
              onClick={() => setMetric(name)}
            >
              {metricLabels[name]}
            </button>
          ))}
        </div>
        </div>
      </div>
      <div className="trend-body">
        {groups.length > (includeAllTab ? 0 : 1) && (
          <div className="trend-tabs" role="tablist" aria-label={scopeLabel}>
            {[...(includeAllTab ? [{ id: null, name: "All" }] : []), ...groups].map((tab) => (
              <button type="button" role="tab" key={tab.id ?? "all"} aria-selected={groupId === tab.id} className={groupId === tab.id ? "selected" : ""} onClick={() => setGroupId(tab.id)}>
                {tab.name}
              </button>
            ))}
          </div>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {!trend ? (
          !error && <p className="empty-copy">Loading coverage history…</p>
        ) : trend.points.length === 0 ? (
          <p className="empty-copy">
            {since
              ? `No completed runs in the last ${range.label}${group ? ` for ${group.name}` : ""}. Choose All to see earlier history.`
              : group ? `No completed runs have reported coverage for ${group.name} yet.` : "Coverage history appears here once a run completes."}
          </p>
        ) : (
          <>
            <div className="trend-summary">
              {summary!.stats.map((stat) => (
                <div key={stat.label} title={stat.title}>
                  <span className="trend-summary-label">{stat.label}</span>
                  <strong>{stat.value}</strong>
                  {stat.details.map((detail) => <span key={detail}>{detail}</span>)}
                  {stat.note && <span className="trend-goal-note">{stat.note}</span>}
                </div>
              ))}
            </div>
            {summary!.movers && (
              <div className="trend-movers">
                {([["Most improved", summary!.movers.improved], ["Most declined", summary!.movers.declined]] as const).map(([label, list]) => (
                  <div key={label}>
                    <span className="trend-summary-label">{label}</span>
                    {list.length ? (
                      <ol>
                        {list.map((mover) => (
                          <li key={mover.appName} title={`${mover.appName}: ${formatPercent(mover.from)} → ${formatPercent(mover.to)}`}>
                            <span>{shortAppName(mover.appName)}</span>
                            <strong>{formatDelta(mover.delta, "pts")}</strong>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>{label === "Most improved" ? "No app improved in this range" : "No app declined in this range"}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
            <TrendChart key={`${groupId ?? "all"}-${metric}-${rangeId}`} trend={trend} metric={metric} goal={goal} focusedApp={visibleFocus} setFocusedApp={setFocusedApp} />
            <div className="trend-footer">
            <details className="trend-table">
              <summary>View as table</summary>
              <div className="table-scroll"><table className="history-table"><thead><tr><th>Completed</th><th>Ref</th><th>{metricLabels[metric]}</th><th>Tests</th><th>Apps run</th></tr></thead><tbody>
                {[...trend.points].reverse().map((point) => (
                  <tr key={point.runId}><td>{longDate(point.recordedAt)}</td><td><code>{point.useLocalWorkingTree ? "local working tree" : point.requestedRef}</code></td><td>{formatPercent(point.total?.percent)}</td><td>{point.testsTotal?.toLocaleString() ?? "—"}</td><td>{point.ranApps.length} of {trend.apps.length}</td></tr>
                ))}
              </tbody></table></div>
            </details>
            <div className="trend-export" role="group" aria-label="Download chart">
              <Icon name="download" size={14} />
              <span>Download</span>
              <button type="button" className="text-button" onClick={() => void exportChart("png")}>PNG</button>
              <button type="button" className="text-button" onClick={() => void exportChart("svg")}>SVG</button>
            </div>
            </div>
            {exportError && <p className="inline-error" role="alert">{exportError}</p>}
          </>
        )}
      </div>
    </section>
  );
}
