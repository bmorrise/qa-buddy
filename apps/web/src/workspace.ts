import { useEffect, useState } from "react";
import type { AppRun, Repository, RunSummary } from "@qa-buddy/shared";
import { api } from "./api";

export type WorkspaceRun = RunSummary & { repositoryName: string };
export const activeStatuses = ["queued", "cloning", "setup", "building", "testing"];
export const needsAttention = (repository: Repository) => Boolean(repository.latestRun && ["failed", "timed_out", "interrupted"].includes(repository.latestRun.status));

export function useWorkspace() {
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [runs, setRuns] = useState<WorkspaceRun[] | null>(null);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await api<{ repositories: Repository[] }>("/api/repositories");
        if (cancelled) return;
        setRepositories(response.repositories);
        setError("");
        const histories = await Promise.allSettled(response.repositories.map(async (repository) => {
          const { runs } = await api<{ runs: RunSummary[] }>(`/api/repositories/${repository.id}/runs`);
          return runs.map((run) => ({ ...run, repositoryName: repository.name }));
        }));
        if (cancelled) return;
        const loaded = histories.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        setRuns(loaded.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
        setHistoryError(histories.some((result) => result.status === "rejected") ? "Some run history could not be loaded. Retrying shortly." : "");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to load repositories.");
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 30_000);
      }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  return { repositories, runs, error, historyError };
}

export function lineCoverage(apps: AppRun[]) {
  const metrics = apps.flatMap((app) => app.coverage?.lines ? [app.coverage.lines] : []);
  const total = metrics.reduce((sum, metric) => sum + metric.total, 0);
  return total ? metrics.reduce((sum, metric) => sum + metric.covered, 0) / total * 100 : null;
}
export function relativeTime(value: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}
export function runDuration(run: RunSummary) {
  if (!run.startedAt) return run.status === "queued" ? "Queued" : "—";
  if (!run.finishedAt) return "In progress";
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function shortAppName(name: string) {
  return name.startsWith("@") ? name.split("/").slice(1).join("/") : name;
}
