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

let directory = "";
let sourceRoot = "";
let database: QaBuddyDatabase;
let worker: QaBuddyWorker;

/**
 * Minimal stand-in for the dockerode surface the worker uses. The runner's test
 * command never finishes on its own, so the only way the run ends is a stop.
 */
function fakeDocker(): { docker: Docker; killed: () => boolean } {
  let killed = false;
  const streams: PassThrough[] = [];

  const container = {
    start: async () => undefined,
    exec: async () => ({
      start: async () => {
        const stream = new PassThrough();
        // The real demuxStream consumes the stream; without a reader "end" never fires.
        stream.resume();
        streams.push(stream);
        if (killed) stream.end();
        return stream;
      },
      inspect: async () => ({ ExitCode: 137 })
    }),
    kill: async () => {
      killed = true;
      for (const stream of streams) stream.end();
    },
    remove: async () => undefined
  };

  const docker = {
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async () => container,
    getContainer: () => container,
    modem: { demuxStream: () => undefined, followProgress: () => undefined }
  };

  return { docker: docker as unknown as Docker, killed: () => killed };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "QA Buddy",
      GIT_AUTHOR_EMAIL: "qa@example.com",
      GIT_COMMITTER_NAME: "QA Buddy",
      GIT_COMMITTER_EMAIL: "qa@example.com"
    }
  });
}

function makeLocalRepository(): string {
  const repository = path.join(sourceRoot, "platform");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(path.join(repository, "src/index.js"), "export const value = 1;\n", "utf8");
  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", "initial");
  return repository;
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
      name: "Web",
      workingDirectory: ".",
      testCommand: "pnpm test",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json"
    }
  ]
};

function makeWorker(docker: Docker): QaBuddyWorker {
  return new QaBuddyWorker({
    database,
    docker,
    dataDirectory: directory,
    workspaceDirectory: path.join(directory, "workspaces"),
    workspaceVolume: "qa-buddy-workspaces",
    localSourceDirectory: sourceRoot,
    historyLimit: 20,
    pollIntervalMs: 10,
    cancellationPollMs: 20
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-cancel-"));
  sourceRoot = mkdtempSync(path.join(tmpdir(), "qa-buddy-source-"));
  database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
});

afterEach(async () => {
  await worker?.stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("stopping an in-flight run", () => {
  it("ends the run as interrupted, skips its apps, and kills the runner", async () => {
    makeLocalRepository();
    const { docker, killed } = fakeDocker();
    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      cancellationPollMs: 20
    });

    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(() => database.getRun(run.id)?.status === "testing", "the run to start testing");

    expect(database.requestRunCancellation(run.id)).toBe("requested");
    await waitFor(() => database.getRun(run.id)?.status === "interrupted", "the run to stop");

    const stopped = database.getRun(run.id);
    expect(stopped?.status).toBe("interrupted");
    expect(stopped?.error).toBe("Run stopped by request");
    expect(stopped?.finishedAt).not.toBeNull();
    expect(stopped?.appRuns.map((app) => app.status)).toEqual(["skipped"]);
    expect(killed()).toBe(true);
  });

  it("leaves no coverage snapshot behind when a run is stopped", async () => {
    makeLocalRepository();
    const { docker } = fakeDocker();
    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      cancellationPollMs: 20
    });

    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(() => database.getRun(run.id)?.status === "testing", "the run to start testing");
    database.requestRunCancellation(run.id);
    await waitFor(() => database.getRun(run.id)?.status === "interrupted", "the run to stop");

    expect(database.listCoverageSnapshots(repository.id)).toEqual([]);
  });

  it("frees the repository so a fresh run can be queued", async () => {
    makeLocalRepository();
    const { docker } = fakeDocker();
    worker = new QaBuddyWorker({
      database,
      docker,
      dataDirectory: directory,
      workspaceDirectory: path.join(directory, "workspaces"),
      workspaceVolume: "qa-buddy-workspaces",
      localSourceDirectory: sourceRoot,
      historyLimit: 20,
      pollIntervalMs: 10,
      cancellationPollMs: 20
    });

    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(() => database.getRun(run.id)?.status === "testing", "the run to start testing");
    expect(() => database.createRun(repository.id, "main")).toThrow("already has");

    database.requestRunCancellation(run.id);
    await waitFor(() => database.getRun(run.id)?.status === "interrupted", "the run to stop");

    expect(() => database.createRun(repository.id, "main")).not.toThrow();
  });

  it("stops during a long build without waiting for it to finish", async () => {
    makeLocalRepository();
    const { docker, killed } = fakeDocker();
    worker = makeWorker(docker);

    const repository = database.createRepository({
      ...repositoryInput,
      // Stands in for an eight-minute monorepo build.
      buildCommand: "pnpm build"
    });
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(() => database.getRun(run.id)?.status === "building", "the build to start");

    expect(database.requestRunCancellation(run.id)).toBe("requested");
    await waitFor(() => database.getRun(run.id)?.status === "interrupted", "the run to stop");

    const stopped = database.getRun(run.id);
    expect(stopped?.status).toBe("interrupted");
    expect(stopped?.error).toBe("Run stopped by request");
    // The build never completed, so no app ever started.
    expect(stopped?.appRuns.map((app) => app.status)).toEqual(["skipped"]);
    expect(killed()).toBe(true);
  });

  it("stops during setup, before the build even starts", async () => {
    makeLocalRepository();
    const { docker } = fakeDocker();
    worker = makeWorker(docker);

    const repository = database.createRepository({
      ...repositoryInput,
      setupCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm build"
    });
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(() => database.getRun(run.id)?.status === "setup", "setup to start");

    database.requestRunCancellation(run.id);
    await waitFor(() => database.getRun(run.id)?.status === "interrupted", "the run to stop");

    expect(database.getRun(run.id)?.status).toBe("interrupted");
  });
});
