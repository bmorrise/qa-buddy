import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTestResults, readTestResults, TEST_RESULTS_FILE_NAME } from "./test-results.js";

describe("Jest and Vitest test result parsing", () => {
  it("captures individual assertions and suite-level failures", () => {
    const root = path.resolve("/checkout");
    const result = parseTestResults(
      JSON.stringify({
        testResults: [
          {
            name: path.join(root, "apps/web/src/example.test.ts"),
            status: "failed",
            assertionResults: [
              { ancestorTitles: ["Example"], title: "passes", fullName: "Example passes", status: "passed", duration: 4 },
              { ancestorTitles: ["Example"], title: "fails", fullName: "Example fails", status: "failed", failureMessages: ["Expected true"] },
              { ancestorTitles: ["Example"], title: "later", fullName: "Example later", status: "pending" },
              { ancestorTitles: ["Example"], title: "future", fullName: "Example future", status: "todo" }
            ]
          },
          {
            name: path.join(root, "apps/api/src/broken.test.ts"),
            status: "failed",
            message: "The suite could not load",
            assertionResults: []
          }
        ]
      }),
      root
    );

    expect(result).toMatchObject({ total: 5, passed: 1, failed: 2, skipped: 1, todo: 1 });
    expect(result.testCases[0]?.filePath).toBe("apps/web/src/example.test.ts");
    expect(result.testCases[1]?.failureMessage).toBe("Expected true");
    expect(result.testCases[4]).toMatchObject({
      status: "failed",
      filePath: "apps/api/src/broken.test.ts",
      failureMessage: "The suite could not load"
    });
  });

  it("reads the conventional app report and explains malformed reports", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-test-results-"));
    try {
      expect(readTestResults(directory, "apps/web")).toBeNull();
      const report = path.join(directory, "apps/web", TEST_RESULTS_FILE_NAME);
      mkdirSync(path.dirname(report), { recursive: true });
      writeFileSync(report, "not-json", "utf8");
      expect(() => readTestResults(directory, "apps/web")).toThrow(/malformed JSON/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
