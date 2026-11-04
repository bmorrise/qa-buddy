import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import type { RepositoryInput } from "@qa-buddy/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyWorker } from "./worker.js";
import { TEST_RESULTS_FILE_NAME } from "./test-results.js";

let directory = "";
let sourceRoot = "";
let database: QaBuddyDatabase;
let worker: QaBuddyWorker;

/**
 * Runs each exec successfully. Before the test command "finishes" it writes the
 * reports a real runner would leave behind in the shared workspace volume.
 */
function fakeDocker(onExec: () => void): Docker {
  const container = {
    start: async () => undefined,
    exec: async () => ({
      start: async () => {
        onExec();
        const stream = new PassThrough();
        stream.resume();
        stream.end();
        return stream;
      },
      inspect: async () => ({ ExitCode: 0 })
    }),
    kill: async () => undefined,
    remove: async () => undefined
  };
  return {
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async () => container,
    getContainer: () => container,
    modem: { demuxStream: () => undefined, followProgress: () => undefined }
  } as unknown as Docker;
}

function makeLocalRepository(): void {
  const repository = path.join(sourceRoot, "platform");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(path.join(repository, "src/index.js"), "export const value = 1;\n", "utf8");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "QA Buddy",
    GIT_AUTHOR_EMAIL: "qa@example.com",
    GIT_COMMITTER_NAME: "QA Buddy",
    GIT_COMMITTER_EMAIL: "qa@example.com"
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repository, env });
  execFileSync("git", ["add", "-A"], { cwd: repository, env });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository, env });
}

const repositoryInput: RepositoryInput = {
  name: "Platform",
  githubUrl: "https://github.com/example/platform.git",
  defaultRef: "main",
  localPath: "platform",
  additionalWorkspaces: [],
  excludedWorkspaces: [],
  runnerImage: "node:22-bookworm",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: false,
  apps: [
    {
      name: "Migrating lib",
      workingDirectory: ".",
      testCommand: "pnpm test",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json"
    }
  ]
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function startWorker(onExec: () => void): void {
  worker = new QaBuddyWorker({
    database,
    docker: fakeDocker(onExec),
    dataDirectory: directory,
    workspaceDirectory: path.join(directory, "workspaces"),
    workspaceVolume: "qa-buddy-workspaces",
    localSourceDirectory: sourceRoot,
    historyLimit: 20,
    pollIntervalMs: 10
  });
  void worker.run();
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-notests-"));
  sourceRoot = mkdtempSync(path.join(tmpdir(), "qa-buddy-notests-src-"));
  database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
  makeLocalRepository();
});

afterEach(async () => {
  await worker?.stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("a suite that reports no tests", () => {
  it("is skipped without failing the run and leaves no coverage snapshot", async () => {
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    // What --passWithNoTests produces: exit 0, an empty report, no coverage.
    startWorker(() => {
      const checkout = path.join(directory, "workspaces", run.id, "repo");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(
        path.join(checkout, TEST_RESULTS_FILE_NAME),
        JSON.stringify({ testResults: [] }),
        "utf8"
      );
    });

    await waitFor(() => database.getRun(run.id)?.status === "passed", "the run to finish");

    const finished = database.getRun(run.id);
    expect(finished?.status).toBe("passed");
    expect(finished?.appRuns[0]?.status).toBe("skipped");
    expect(finished?.appRuns[0]?.coverageError).toBe("No tests were found in this workspace");
    expect(database.listCoverageSnapshots(repository.id)).toEqual([]);
  });

  it("still fails an app that ran tests but produced no coverage report", async () => {
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    startWorker(() => {
      const checkout = path.join(directory, "workspaces", run.id, "repo");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(
        path.join(checkout, TEST_RESULTS_FILE_NAME),
        JSON.stringify({
          testResults: [
            { name: "a.test.ts", status: "passed", assertionResults: [{ title: "works", status: "passed" }] }
          ]
        }),
        "utf8"
      );
    });

    await waitFor(() => database.getRun(run.id)?.status === "failed", "the run to fail");
    expect(database.getRun(run.id)?.appRuns[0]?.status).toBe("failed");
  });
});
