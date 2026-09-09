import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryInput } from "@qa-buddy/shared";
import { QaBuddyDatabase } from "./database.js";

const input: RepositoryInput = {
  name: "Example platform",
  githubUrl: "https://github.com/example/platform.git",
  defaultRef: "main",
  runnerImage: "node:22-bookworm",
  setupCommand: "npm ci",
  buildCommand: "npm run build",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: ["NPM_TOKEN"],
  autoDetect: false,
  apps: [
    {
      name: "Web",
      workingDirectory: "apps/web",
      testCommand: "npm test -- --coverage",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "apps/web/coverage/coverage-summary.json"
    },
    {
      name: "API",
      workingDirectory: "apps/api",
      testCommand: "npm test -- --coverage",
      coverageFormat: "lcov",
      coveragePath: "apps/api/coverage/lcov.info"
    }
  ]
};

describe("QaBuddyDatabase", () => {
  let directory: string;
  let database: QaBuddyDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-db-"));
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists repositories and immutable run snapshots", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, "feature/test");
    database.updateRepository(repository.id, { ...input, name: "Renamed platform", apps: [input.apps[0]!] });

    expect(database.getRepository(repository.id)?.name).toBe("Renamed platform");
    expect(database.getRun(run.id)?.configurationSnapshot.name).toBe("Example platform");
    expect(database.getRun(run.id)?.configurationSnapshot.buildCommand).toBe("npm run build");
    expect(database.getRun(run.id)?.configurationSnapshot.testWorkerLimit).toBe(2);
    expect(database.getRun(run.id)?.appRuns).toHaveLength(2);
  });

  it("creates a run for only the selected configured apps", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id, undefined, ["API"]);

    expect(run.selectedApps).toEqual(["API"]);
    expect(run.configurationSnapshot.apps).toHaveLength(2);
    expect(run.configurationSnapshot.selectedApps).toEqual(["API"]);
    expect(run.appRuns.map((app) => app.name)).toEqual(["API"]);
  });

  it("stores run-specific apps discovered from a pnpm workspace", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id);
    expect(run.appRuns).toHaveLength(0);

    const detected = database.setDetectedApps(run.id, [input.apps[0]!]);
    expect(detected.appRuns).toHaveLength(1);
    expect(detected.configurationSnapshot.apps[0]?.name).toBe("Web");
    expect(database.getRepository(repository.id)?.apps).toHaveLength(0);
  });

  it("filters detected apps to the immutable run selection", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id, undefined, ["API"]);
    const detected = database.setDetectedApps(run.id, input.apps);

    expect(detected.configurationSnapshot.apps).toEqual(input.apps);
    expect(detected.selectedApps).toEqual(["API"]);
    expect(detected.appRuns.map((app) => app.name)).toEqual(["API"]);
    expect(database.getRepositoryDetail(repository.id)?.selectableApps).toEqual(input.apps);
  });

  it("rejects selected apps that are absent from the requested ref", () => {
    const repository = database.createRepository({ ...input, autoDetect: true, apps: [] });
    const run = database.createRun(repository.id, undefined, ["Missing"]);

    expect(() => database.setDetectedApps(run.id, input.apps)).toThrow(/not detected.*Missing/);
  });

  it("claims runs sequentially and prevents duplicate active runs per repository", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id);
    expect(() => database.createRun(repository.id)).toThrow(/already has/);
    expect(database.claimNextRun()?.id).toBe(run.id);
    expect(database.claimNextRun()).toBeNull();
  });

  it("records app coverage and run outcomes", () => {
    const repository = database.createRepository(input);
    const run = database.createRun(repository.id);
    database.claimNextRun();
    const app = run.appRuns[0]!;
    database.startAppRun(app.id);
    database.finishAppRun(app.id, {
      status: "passed",
      exitCode: 0,
      coverage: {
        lines: { covered: 9, total: 10, percent: 90 },
        statements: { covered: 9, total: 10, percent: 90 },
        functions: { covered: 3, total: 4, percent: 75 },
        branches: { covered: 2, total: 4, percent: 50 }
      },
      testResults: {
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        todo: 0,
        testCases: [
          {
            name: "works",
            fullName: "suite works",
            ancestorTitles: ["suite"],
            filePath: "src/example.test.ts",
            status: "passed",
            durationMs: 4,
            failureMessage: null
          },
          {
            name: "fails",
            fullName: "suite fails",
            ancestorTitles: ["suite"],
            filePath: "src/example.test.ts",
            status: "failed",
            durationMs: 2,
            failureMessage: "Expected true"
          }
        ]
      }
    });
    database.updateRun(run.id, { status: "passed", finished: true });

    const result = database.getRun(run.id)!;
    expect(result.status).toBe("passed");
    expect(result.appRuns[0]?.coverage?.lines?.percent).toBe(90);
    expect(result.appRuns[0]?.testResults?.failed).toBe(1);
    expect(result.appRuns[0]?.testResults?.testCases[1]?.failureMessage).toBe("Expected true");
    expect(result.finishedAt).not.toBeNull();
  });

  it("interrupts active work but leaves queued jobs available", () => {
    const first = database.createRepository(input);
    const second = database.createRepository({
      ...input,
      name: "Second",
      githubUrl: "https://github.com/example/second.git"
    });
    const active = database.createRun(first.id);
    database.claimNextRun();
    const queued = database.createRun(second.id);

    expect(database.markActiveRunsInterrupted()).toEqual([active.id]);
    expect(database.getRun(active.id)?.status).toBe("interrupted");
    expect(database.getRun(queued.id)?.status).toBe("queued");
  });

  it("prunes older history and blocks deletion during active work", () => {
    const repository = database.createRepository(input);
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = database.createRun(repository.id);
      runIds.push(run.id);
      database.claimNextRun();
      database.updateRun(run.id, { status: "passed", finished: true });
    }
    expect(database.pruneRuns(repository.id, 2)).toEqual([runIds[0]]);
    expect(database.listRuns(repository.id, 20)).toHaveLength(2);

    database.createRun(repository.id);
    expect(database.deleteRepository(repository.id)).toMatchObject({ deleted: false, active: true });
  });
});
