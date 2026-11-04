import { describe, expect, it } from "vitest";
import {
  APP_TIME_LIMIT_DEFAULT_MS,
  APP_TIME_LIMIT_FLOOR_MS,
  appTimeLimit,
  formatMinutes
} from "./timeouts.js";

const minutes = (value: number) => value * 60_000;

describe("appTimeLimit", () => {
  it("uses the default limit for an app with no passing history", () => {
    expect(appTimeLimit([])).toEqual({
      limitMs: APP_TIME_LIMIT_DEFAULT_MS,
      basis: "default; no recent passing runs"
    });
  });

  it("gives fast apps the minimum limit rather than a few seconds", () => {
    expect(appTimeLimit([2_000, 5_000])).toEqual({
      limitMs: APP_TIME_LIMIT_FLOOR_MS,
      basis: "minimum limit"
    });
  });

  it("scales from the slowest recent pass so a slow but healthy app keeps headroom", () => {
    expect(appTimeLimit([minutes(13), minutes(16), minutes(15)])).toEqual({
      limitMs: minutes(48),
      basis: "3x its slowest recent pass of 16 minutes"
    });
  });
});

describe("formatMinutes", () => {
  it("rounds to a tenth of a minute", () => {
    expect(formatMinutes(minutes(1))).toBe("1 minute");
    expect(formatMinutes(95_000)).toBe("1.6 minutes");
  });
});
