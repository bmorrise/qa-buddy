import { describe, expect, it } from "vitest";
import { parseIstanbulSummary, parseLcov } from "./coverage.js";

describe("coverage parsers", () => {
  it("parses Istanbul coverage-summary JSON using counts", () => {
    const result = parseIstanbulSummary(
      JSON.stringify({
        total: {
          lines: { total: 10, covered: 8, pct: 1 },
          statements: { total: 12, covered: 9, pct: 1 },
          functions: { total: 4, covered: 2, pct: 1 },
          branches: { total: 8, covered: 3, pct: 1 }
        }
      })
    );
    expect(result.lines).toEqual({ covered: 8, total: 10, percent: 80 });
    expect(result.statements?.percent).toBe(75);
    expect(result.functions?.percent).toBe(50);
    expect(result.branches?.percent).toBe(37.5);
  });

  it("returns a null percentage for zero-sized Istanbul metrics", () => {
    const result = parseIstanbulSummary(
      JSON.stringify({
        total: {
          lines: { total: 0, covered: 0 },
          statements: { total: 0, covered: 0 },
          functions: { total: 0, covered: 0 },
          branches: { total: 0, covered: 0 }
        }
      })
    );
    expect(result.lines?.percent).toBeNull();
  });

  it("aggregates LCOV data without inventing statement coverage", () => {
    const result = parseLcov(`
TN:
SF:/workspace/src/a.ts
FN:1,one
FNDA:2,one
FN:5,two
FNDA:0,two
DA:1,3
DA:2,0
BRDA:2,0,0,1
BRDA:2,0,1,-
end_of_record
SF:/workspace/src/b.ts
DA:1,1
end_of_record
`);
    expect(result.lines).toEqual({ covered: 2, total: 3, percent: 66.7 });
    expect(result.functions).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(result.branches).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(result.statements).toBeNull();
  });

  it("reports malformed or empty coverage explicitly", () => {
    expect(() => parseIstanbulSummary("not json")).toThrow(/valid JSON/);
    expect(() => parseIstanbulSummary('{"total":{}}')).toThrow(/missing lines/);
    expect(() => parseLcov("TN:\n")).toThrow(/does not contain/);
  });
});
