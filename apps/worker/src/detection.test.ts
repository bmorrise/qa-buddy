import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAppReports, detectPnpmWorkspaceApps, discoverCoverageReport } from "./detection.js";

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

describe("pnpm and Turborepo detection", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-detect-"));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("prioritizes testable apps and derives commands from package scripts", async () => {
    writeFileSync(
      path.join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      "utf8"
    );
    writeJson(path.join(directory, "turbo.json"), { tasks: { test: {} } });
    writeJson(path.join(directory, "apps/web/package.json"), {
      name: "@example/web",
      scripts: { test: "vitest run" }
    });
    writeJson(path.join(directory, "apps/admin/package.json"), {
      name: "@example/admin",
      scripts: { "test:coverage": "vitest run --coverage" }
    });
    writeJson(path.join(directory, "apps/docs/package.json"), {
      name: "@example/docs",
      scripts: { dev: "vite" }
    });
    writeJson(path.join(directory, "packages/ui/package.json"), {
      name: "@example/ui",
      scripts: { test: "vitest run" }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.hasTurbo).toBe(true);
    expect(result.workspaceCount).toBe(4);
    expect(result.apps.map((app) => app.name)).toEqual(["@example/admin", "@example/web"]);
    expect(result.apps.map((app) => app.testCommand)).toEqual([
      "pnpm run test:coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportOnFailure --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile.json=.qa-buddy-test-results.json",
      "pnpm test --coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportOnFailure --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile.json=.qa-buddy-test-results.json"
    ]);
    expect(result.apps.every((app) => app.workingDirectory.startsWith("apps/"))).toBe(true);
  });

  it("uses runner-specific coverage arguments for test-only scripts", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/vitest/package.json"), {
      name: "vitest-app",
      scripts: { test: "vitest run" }
    });
    writeJson(path.join(directory, "apps/jest/package.json"), {
      name: "jest-app",
      scripts: { test: "NODE_ENV=test jest --passWithNoTests" }
    });
    writeJson(path.join(directory, "apps/custom/package.json"), {
      name: "custom-app",
      scripts: { test: "node test.js" }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps.map(({ name, testCommand }) => ({ name, testCommand }))).toEqual([
      { name: "custom-app", testCommand: "pnpm test --coverage" },
      {
        name: "jest-app",
        testCommand: "pnpm test --coverage --coverageReporters=json-summary --coverageReporters=json --maxWorkers=2 --workerIdleMemoryLimit=1GB --coveragePathIgnorePatterns=/dist/ --json --outputFile=.qa-buddy-test-results.json"
      },
      {
        name: "vitest-app",
        testCommand: "pnpm test --coverage --coverage.reporter=json-summary --coverage.reporter=json --coverage.reportOnFailure --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile.json=.qa-buddy-test-results.json"
      }
    ]);
  });

  it("applies a configurable worker limit to Jest and Vitest", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/vitest/package.json"), {
      name: "vitest-app",
      scripts: { test: "vitest run" }
    });
    writeJson(path.join(directory, "apps/jest/package.json"), {
      name: "jest-app",
      scripts: { test: "jest" }
    });

    const result = await detectPnpmWorkspaceApps(directory, 1);
    expect(result.apps.find((app) => app.name === "jest-app")?.testCommand).toContain("--maxWorkers=1");
    expect(result.apps.find((app) => app.name === "jest-app")?.testCommand).toContain(
      "--coveragePathIgnorePatterns=/dist/"
    );
    expect(result.apps.find((app) => app.name === "jest-app")?.testCommand).toContain(
      "--workerIdleMemoryLimit=1GB"
    );
    expect(result.apps.find((app) => app.name === "vitest-app")?.testCommand).toContain(
      "--maxWorkers=1 --minWorkers=1"
    );
  });

  it("uses Vitest 4 worker flags without the removed minWorkers option", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/vitest/package.json"), {
      name: "vitest-app",
      scripts: { "test:coverage": "vitest run --coverage" },
      devDependencies: { vitest: "^4.1.11" }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps[0]?.testCommand).toContain("--coverage.reporter=json-summary");
    expect(result.apps[0]?.testCommand).toContain("--maxWorkers=2");
    expect(result.apps[0]?.testCommand).not.toContain("--minWorkers");
  });

  it("retains the minWorkers constraint for Vitest 3", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/vitest/package.json"), {
      name: "vitest-app",
      scripts: { test: "vitest run" },
      dependencies: { vitest: "~3.2.4" }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps[0]?.testCommand).toContain("--maxWorkers=2 --minWorkers=1");
  });

  it("prefers test:cov and preserves serial Jest execution", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/processor/package.json"), {
      name: "processor",
      scripts: {
        test: "jest --runInBand --watchman=false",
        "test:cov": "jest --coverage --runInBand --watchman=false"
      }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps[0]?.testCommand).toContain("pnpm run test:cov");
    expect(result.apps[0]?.testCommand).toContain("--coverageReporters=json-summary");
    expect(result.apps[0]?.testCommand).not.toContain("--maxWorkers");
    expect(result.apps[0]?.testCommand).not.toContain("--workerIdleMemoryLimit");
    expect(result.apps[0]?.testCommand).toContain("--json --outputFile=.qa-buddy-test-results.json");
  });

  it("falls back to all pnpm workspaces when there is no apps directory", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'services/*'\n", "utf8");
    writeJson(path.join(directory, "services/api/package.json"), {
      name: "api",
      scripts: { coverage: "node coverage.js" }
    });
    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps).toMatchObject([
      { name: "api", workingDirectory: "services/api", testCommand: "pnpm run coverage" }
    ]);
  });

  it("discovers Istanbul JSON first and LCOV as a fallback", () => {
    writeJson(path.join(directory, "apps/web/coverage/coverage-summary.json"), {
      total: {
        lines: { total: 10, covered: 9 },
        statements: { total: 10, covered: 8 },
        functions: { total: 4, covered: 3 },
        branches: { total: 6, covered: 3 }
      }
    });
    const json = discoverCoverageReport(directory, "apps/web");
    expect(json.coverageFormat).toBe("istanbul-summary-json");
    expect(json.coverage.lines?.percent).toBe(90);

    mkdirSync(path.join(directory, "apps/api/coverage"), { recursive: true });
    writeFileSync(
      path.join(directory, "apps/api/coverage/lcov.info"),
      "SF:index.ts\nDA:1,1\nDA:2,0\nend_of_record\n",
      "utf8"
    );
    const lcov = discoverCoverageReport(directory, "apps/api");
    expect(lcov.coverageFormat).toBe("lcov");
    expect(lcov.coverage.lines?.percent).toBe(50);

    mkdirSync(path.join(directory, "coverage/apps/admin"), { recursive: true });
    writeFileSync(
      path.join(directory, "coverage/apps/admin/lcov.info"),
      "SF:admin.ts\nDA:1,1\nDA:2,1\nend_of_record\n",
      "utf8"
    );
    const monorepo = discoverCoverageReport(directory, "apps/admin");
    expect(monorepo.coveragePath).toBe("coverage/apps/admin/lcov.info");
    expect(monorepo.coverage.lines?.percent).toBe(100);
  });

  it("honors a safe Jest coverageDirectory outside the app directory", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/api/package.json"), {
      name: "api",
      scripts: { test: "jest" },
      jest: { coverageDirectory: "../coverage" }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps[0]?.coveragePath).toBe("apps/coverage/coverage-summary.json");

    writeJson(path.join(directory, "apps/coverage/coverage-summary.json"), {
      total: {
        lines: { total: 4, covered: 3 },
        statements: { total: 4, covered: 3 },
        functions: { total: 2, covered: 1 },
        branches: { total: 2, covered: 1 }
      }
    });
    const coverage = discoverCoverageReport(
      directory,
      "apps/api",
      result.apps[0]?.coveragePath
    );
    expect(coverage.coveragePath).toBe("apps/coverage/coverage-summary.json");
    expect(coverage.coverage.lines?.percent).toBe(75);
  });

  it("finds LCOV beside a configured shared Jest summary path", () => {
    mkdirSync(path.join(directory, "apps/coverage"), { recursive: true });
    writeFileSync(
      path.join(directory, "apps/coverage/lcov.info"),
      "SF:index.ts\nDA:1,1\nDA:2,0\nend_of_record\n",
      "utf8"
    );

    const coverage = discoverCoverageReport(
      directory,
      "apps/api",
      "apps/coverage/coverage-summary.json"
    );
    expect(coverage.coverageFormat).toBe("lcov");
    expect(coverage.coveragePath).toBe("apps/coverage/lcov.info");
    expect(coverage.coverage.lines?.percent).toBe(50);
  });

  it("clears stale configured and conventional reports without touching unrelated files", () => {
    writeJson(path.join(directory, "apps/coverage/coverage-summary.json"), { stale: true });
    writeFileSync(path.join(directory, "apps/coverage/lcov.info"), "stale", "utf8");
    writeJson(path.join(directory, "apps/api/coverage/coverage-summary.json"), { stale: true });
    writeJson(path.join(directory, "apps/api/.qa-buddy-test-results.json"), { stale: true });
    writeJson(path.join(directory, "apps/api/keep.json"), { keep: true });

    const removed = clearAppReports(
      directory,
      "apps/api",
      "apps/coverage/coverage-summary.json"
    );

    expect(removed).toContain("apps/coverage/coverage-summary.json");
    expect(removed).toContain("apps/coverage/lcov.info");
    expect(removed).toContain("apps/api/coverage/coverage-summary.json");
    expect(removed).toContain("apps/api/.qa-buddy-test-results.json");
    expect(existsSync(path.join(directory, "apps/coverage/coverage-summary.json"))).toBe(false);
    expect(existsSync(path.join(directory, "apps/coverage/lcov.info"))).toBe(false);
    expect(existsSync(path.join(directory, "apps/api/coverage/coverage-summary.json"))).toBe(false);
    expect(existsSync(path.join(directory, "apps/api/.qa-buddy-test-results.json"))).toBe(false);
    expect(existsSync(path.join(directory, "apps/api/keep.json"))).toBe(true);
  });

  it("ignores a Jest coverageDirectory that escapes the checkout", async () => {
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/api/package.json"), {
      name: "api",
      scripts: { test: "jest" },
      jest: { coverageDirectory: "../../../outside" }
    });

    const result = await detectPnpmWorkspaceApps(directory);
    expect(result.apps[0]?.coveragePath).toBe("apps/api/coverage/coverage-summary.json");
  });

  it("reports missing workspace configuration and test scripts clearly", async () => {
    await expect(detectPnpmWorkspaceApps(directory)).rejects.toThrow(/requires pnpm-workspace/);
    writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
    writeJson(path.join(directory, "apps/web/package.json"), { name: "web", scripts: { build: "vite build" } });
    await expect(detectPnpmWorkspaceApps(directory)).rejects.toThrow(/No coverage-capable test scripts/);
  });

  describe("additional workspaces", () => {
    function platformLayout(): void {
      writeFileSync(
        path.join(directory, "pnpm-workspace.yaml"),
        "packages:\n  - 'apps/*'\n  - 'libs/*'\n",
        "utf8"
      );
      writeJson(path.join(directory, "apps/idcloud/package.json"), {
        name: "idcloud",
        scripts: { "test:coverage": "vitest run --coverage" }
      });
      writeJson(path.join(directory, "libs/scout-ui/package.json"), {
        name: "scout-ui",
        scripts: { "test:coverage": "vitest run --coverage" }
      });
      writeJson(path.join(directory, "libs/infuse-ui/package.json"), {
        name: "infuse-ui",
        scripts: { coverage: "vitest run --coverage" }
      });
      // No test script at all: never eligible, listed or not.
      writeJson(path.join(directory, "libs/typescript-config/package.json"), {
        name: "typescript-config",
        scripts: { lint: "eslint ." }
      });
    }

    it("ignores libs unless they are explicitly requested", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2);
      expect(result.apps.map((app) => app.workingDirectory)).toEqual(["apps/idcloud"]);
    });

    it("adds only the requested libs alongside every app", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2, ["libs/scout-ui"]);

      expect(result.apps.map((app) => app.workingDirectory)).toEqual(["apps/idcloud", "libs/scout-ui"]);
      const lib = result.apps.find((app) => app.workingDirectory === "libs/scout-ui");
      expect(lib?.name).toBe("scout-ui");
      expect(lib?.testCommand).toContain("pnpm run test:coverage");
      expect(lib?.coveragePath).toBe("libs/scout-ui/coverage/coverage-summary.json");
    });

    it("tolerates a trailing slash and duplicate entries", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2, ["libs/scout-ui/", "libs/scout-ui"]);
      expect(result.apps.filter((app) => app.workingDirectory === "libs/scout-ui")).toHaveLength(1);
    });

    it("fails loudly when a requested workspace does not exist", async () => {
      platformLayout();
      await expect(detectPnpmWorkspaceApps(directory, 2, ["libs/scout-uii"])).rejects.toThrow(
        "Additional workspaces not found in this repository: libs/scout-uii"
      );
    });

    it("skips a requested workspace that has no test script without failing", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2, ["libs/typescript-config", "libs/infuse-ui"]);
      expect(result.apps.map((app) => app.workingDirectory)).toEqual([
        "apps/idcloud",
        "libs/infuse-ui"
      ]);
    });
  });

  describe("excluded workspaces", () => {
    function platformLayout(): void {
      writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
      writeJson(path.join(directory, "apps/idcloud/package.json"), {
        name: "idcloud",
        scripts: { "test:coverage": "vitest run --coverage" }
      });
      // Mirrors idplans-platform: a vitest script with no test files behind it.
      writeJson(path.join(directory, "apps/user-crm-sync/package.json"), {
        name: "@idplans-platform/user-crm-sync",
        scripts: { "test:coverage": "vitest run --coverage --passWithNoTests" }
      });
    }

    it("skips an excluded workspace that would otherwise be detected", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2, [], ["apps/user-crm-sync"]);
      expect(result.apps.map((app) => app.workingDirectory)).toEqual(["apps/idcloud"]);
      expect(result.excluded).toEqual(["apps/user-crm-sync"]);
      expect(result.unmatchedExclusions).toEqual([]);
    });

    it("tolerates a trailing slash and duplicate entries", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2, [], ["apps/user-crm-sync/", "apps/user-crm-sync"]);
      expect(result.apps.map((app) => app.workingDirectory)).toEqual(["apps/idcloud"]);
      expect(result.excluded).toEqual(["apps/user-crm-sync"]);
    });

    it("reports an exclusion that matches no workspace without failing", async () => {
      platformLayout();
      const result = await detectPnpmWorkspaceApps(directory, 2, [], ["apps/idvision-e2e"]);
      expect(result.apps.map((app) => app.workingDirectory)).toEqual(["apps/idcloud", "apps/user-crm-sync"]);
      expect(result.excluded).toEqual([]);
      expect(result.unmatchedExclusions).toEqual(["apps/idvision-e2e"]);
    });

    it("can exclude a workspace from the no-apps fallback", async () => {
      writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf8");
      writeJson(path.join(directory, "packages/core/package.json"), { name: "core", scripts: { test: "vitest run" } });
      writeJson(path.join(directory, "packages/legacy/package.json"), { name: "legacy", scripts: { test: "vitest run" } });
      const result = await detectPnpmWorkspaceApps(directory, 2, [], ["packages/legacy"]);
      expect(result.apps.map((app) => app.workingDirectory)).toEqual(["packages/core"]);
    });

    it("names the exclusions when nothing testable remains", async () => {
      platformLayout();
      await expect(
        detectPnpmWorkspaceApps(directory, 2, [], ["apps/idcloud", "apps/user-crm-sync"])
      ).rejects.toThrow(/No coverage-capable test scripts.*excluded: apps\/idcloud, apps\/user-crm-sync/);
    });
  });

  it("attaches gap details from the detailed report next to the summary, and clears it before a run", () => {
    const root = directory;
    writeJson(path.join(root, "apps/api/coverage/coverage-summary.json"), {
      total: { lines: { covered: 1, total: 2 }, statements: { covered: 1, total: 2 }, functions: { covered: 0, total: 1 }, branches: { covered: 0, total: 0 } },
      [path.join(root, "apps/api/src/users.ts")]: { lines: { covered: 1, total: 2 }, statements: { covered: 1, total: 2 }, functions: { covered: 0, total: 1 }, branches: { covered: 0, total: 0 } }
    });
    writeJson(path.join(root, "apps/api/coverage/coverage-final.json"), {
      [path.join(root, "apps/api/src/users.ts")]: {
        path: path.join(root, "apps/api/src/users.ts"),
        statementMap: { "0": { start: { line: 1 } }, "1": { start: { line: 2 } } },
        s: { "0": 1, "1": 0 },
        fnMap: { "0": { name: "remove", decl: { start: { line: 2 } } } },
        f: { "0": 0 },
        branchMap: {},
        b: {}
      }
    });
    const discovered = discoverCoverageReport(root, "apps/api");
    expect(discovered.coverageFiles[0]).toMatchObject({
      path: "apps/api/src/users.ts",
      details: { uncoveredLines: [[2, 2]], uncoveredFunctions: [{ name: "remove", line: 2 }], uncoveredBranches: [] }
    });

    expect(clearAppReports(root, "apps/api")).toEqual(["apps/api/coverage/coverage-summary.json", "apps/api/coverage/coverage-final.json"]);
    expect(existsSync(path.join(root, "apps/api/coverage/coverage-final.json"))).toBe(false);
  });

  it("keeps summary coverage when the detailed report is missing or unreadable", () => {
    writeJson(path.join(directory, "apps/api/coverage/coverage-summary.json"), {
      total: { lines: { covered: 1, total: 1 }, statements: { covered: 1, total: 1 }, functions: { covered: 1, total: 1 }, branches: { covered: 0, total: 0 } },
      "apps/api/src/a.ts": { lines: { covered: 1, total: 1 }, statements: { covered: 1, total: 1 }, functions: { covered: 1, total: 1 }, branches: { covered: 0, total: 0 } }
    });
    expect(discoverCoverageReport(directory, "apps/api").coverageFiles[0]!.details).toBeUndefined();
    writeFileSync(path.join(directory, "apps/api/coverage/coverage-final.json"), "{ not json", "utf8");
    expect(discoverCoverageReport(directory, "apps/api").coverageFiles[0]!.details).toBeUndefined();
  });
});
