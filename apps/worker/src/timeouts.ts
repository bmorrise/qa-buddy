/** Any setup, build, or test command that prints nothing for this long is treated as hung. */
export const IDLE_TIMEOUT_MS = 10 * 60_000;

/** An app may take this many times its slowest recent passing run. */
export const APP_TIME_LIMIT_MULTIPLIER = 3;

/** Fast apps still get this long, so a busy machine does not fail them. */
export const APP_TIME_LIMIT_FLOOR_MS = 10 * 60_000;

/** Limit for an app that has never passed in this repository. */
export const APP_TIME_LIMIT_DEFAULT_MS = 30 * 60_000;

/** How many recent passing runs of each app inform its limit. */
export const APP_TIME_LIMIT_HISTORY = 5;

export interface AppTimeLimit {
  limitMs: number;
  /** Human-readable explanation for the run log. */
  basis: string;
}

export function formatMinutes(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 6_000) / 10;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Derives one app's time limit from how long it took on recent passing runs,
 * so a slow-but-healthy app keeps its headroom while a stuck one fails alone.
 */
export function appTimeLimit(recentPassingDurationsMs: number[]): AppTimeLimit {
  if (recentPassingDurationsMs.length === 0) {
    return { limitMs: APP_TIME_LIMIT_DEFAULT_MS, basis: "default; no recent passing runs" };
  }
  const slowest = Math.max(...recentPassingDurationsMs);
  const scaled = slowest * APP_TIME_LIMIT_MULTIPLIER;
  if (scaled <= APP_TIME_LIMIT_FLOOR_MS) {
    return { limitMs: APP_TIME_LIMIT_FLOOR_MS, basis: "minimum limit" };
  }
  return {
    limitMs: scaled,
    basis: `${APP_TIME_LIMIT_MULTIPLIER}x its slowest recent pass of ${formatMinutes(slowest)}`
  };
}
