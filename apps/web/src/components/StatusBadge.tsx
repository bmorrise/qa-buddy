import type { AppRunStatus, RunStatus } from "@qa-buddy/shared";

const labels: Record<RunStatus | AppRunStatus, string> = {
  queued: "Queued",
  cloning: "Cloning",
  setup: "Setup",
  building: "Building",
  testing: "Testing",
  passed: "Passed",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
  pending: "Pending",
  running: "Running",
  skipped: "Skipped"
};

export function StatusBadge({ status }: { status: RunStatus | AppRunStatus }) {
  return <span className={`status status-${status}`}>{labels[status]}</span>;
}
