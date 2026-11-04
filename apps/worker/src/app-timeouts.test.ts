import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import type { RepositoryInput } from "@qa-buddy/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerRunner, RunnerTimeoutError } from "./docker-runner.js";
import { RunLogger } from "./logger.js";
import { QaBuddyWorker, type WorkerOptions } from "./worker.js";

let directory = "";
let sourceRoot = "";
let database: QaBuddyDatabase;
let worker: QaBuddyWorker;

interface FakeRunner {
  docker: Docker;
  /** Commands the worker asked the runner to execute, in order. */
  commands: string[];
  groupKills: () => number;
  containerKilled: () => boolean;
}

/**
 * Stand-in for the dockerode surface the worker uses. Commands listed in
 * `hanging` never finish on their own; a process-group kill ends them with 137,
 * like the real runner. Every other command exits 0 straight away.
 */
function fakeRunner(hanging: string[], options: { ignoreGroupKill?: boolean } = {}): FakeRunner {
  const commands: string[] = [];
  const openStreams: PassThrough[] = [];
  let groupKills = 0;
  let containerKilled = false;

  const container = {
    start: async () => undefined,
    exec: async ({ Cmd }: { Cmd: string[] }) => {
      const script = Cmd[2] ?? "";
      if (script.includes("kill -KILL")) {
        groupKills += 1;
        if (!options.ignoreGroupKill) for (const stream of openStreams.splice(0)) stream.end();
        return {
          start: async () => {
            const stream = new PassThrough();
            setImmediate(() => stream.end());
            return stream;
          }
        };
      }
      const command = Cmd[4] ?? "";
      commands.push(command);
      const hangs = hanging.includes(command);
      return {
        start: async () => {
          const stream = new PassThrough();
          // The real demuxStream consumes the stream; without a reader "end" never fires.
          stream.resume();
          if (hangs && !containerKilled) openStreams.push(stream);
          else setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ ExitCode: hangs ? 137 : 0 })
      };
    },
    kill: async () => {
      containerKilled = true;
      for (const stream of openStreams.splice(0)) stream.end();
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

  return {
    docker: docker as unknown as Docker,
    commands,
    groupKills: () => groupKills,
    containerKilled: () => containerKilled
  };
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

function makeLocalRepository(): void {
  const repository = path.join(sourceRoot, "platform");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(path.join(repository, "src/index.js"), "export const value = 1;\n", "utf8");
  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", "initial");
}

const app = (name: string, testCommand: string) => ({
  name,
  workingDirectory: ".",
  testCommand,
  coverageFormat: "istanbul-summary-json" as const,
  coveragePath: "coverage/coverage-summary.json"
});

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
  apps: [app("Slow", "test slow"), app("Fast", "test fast")]
};

function makeWorker(docker: Docker, overrides: Partial<WorkerOptions> = {}): QaBuddyWorker {
  return new QaBuddyWorker({
    database,
    docker,
    dataDirectory: directory,
    workspaceDirectory: path.join(directory, "workspaces"),
    workspaceVolume: "qa-buddy-workspaces",
    localSourceDirectory: sourceRoot,
    historyLimit: 20,
    pollIntervalMs: 10,
    cancellationPollMs: 20,
    ...overrides
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

const finished = (runId: string) => () => {
  const status = database.getRun(runId)?.status;
  return status === "passed" || status === "failed" || status === "timed_out" || status === "interrupted";
};

const runLog = (runId: string) => readFileSync(path.join(directory, "logs", `${runId}.log`), "utf8");

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-timeouts-"));
  sourceRoot = mkdtempSync(path.join(tmpdir(), "qa-buddy-source-"));
  database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
  makeLocalRepository();
});

afterEach(async () => {
  await worker?.stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("per-app time limits", () => {
  it("fails only the app that runs past its limit and keeps testing the rest", async () => {
    const runner = fakeRunner(["test slow"]);
    worker = makeWorker(runner.docker, {
      appTimeLimit: () => ({ limitMs: 50, basis: "test limit" })
    });
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(finished(run.id), "the run to finish");

    const result = database.getRun(run.id)!;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("(1 timed out)");
    const [slow, fast] = result.appRuns;
    expect(slow?.status).toBe("failed");
    expect(slow?.coverageError).toContain("time limit");
    // The next app still ran in the same runner rather than being skipped.
    expect(fast?.status).not.toBe("skipped");
    expect(runner.commands).toEqual(["test slow", "test fast"]);
    expect(runner.groupKills()).toBe(1);
    expect(runner.containerKilled()).toBe(false);
    expect(runLog(run.id)).toContain("Slow timed out: Command exceeded its");
  });

  it("treats an app that stops printing output as hung", async () => {
    const runner = fakeRunner(["test slow"]);
    worker = makeWorker(runner.docker, { idleTimeoutMs: 50 });
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(finished(run.id), "the run to finish");

    const [slow, fast] = database.getRun(run.id)!.appRuns;
    expect(slow?.coverageError).toContain("produced no output");
    expect(fast?.status).not.toBe("skipped");
    expect(runner.containerKilled()).toBe(false);
  });

  it("logs each app's limit and where it came from", async () => {
    const runner = fakeRunner([]);
    worker = makeWorker(runner.docker);
    const repository = database.createRepository(repositoryInput);
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(finished(run.id), "the run to finish");

    expect(runLog(run.id)).toContain("Testing Slow (time limit 30 minutes: default; no recent passing runs)");
  });

  it("ends the run as timed out when a hung build blocks every app", async () => {
    const runner = fakeRunner(["pnpm build"]);
    worker = makeWorker(runner.docker, { idleTimeoutMs: 50 });
    const repository = database.createRepository({ ...repositoryInput, buildCommand: "pnpm build" });
    const run = database.createRun(repository.id, "main", undefined, true);

    void worker.run();
    await waitFor(finished(run.id), "the run to finish");

    const result = database.getRun(run.id)!;
    expect(result.status).toBe("timed_out");
    expect(result.error).toContain("produced no output");
    expect(result.appRuns.map((appRun) => appRun.status)).toEqual(["skipped", "skipped"]);
  });

  it("shuts the runner down when a timed-out command will not stop", async () => {
    const runner = fakeRunner(["test slow"], { ignoreGroupKill: true });
    const dockerRunner = new DockerRunner(runner.docker, {
      runId: "run",
      image: "node:22-bookworm",
      workspaceVolume: "qa-buddy-workspaces",
      workspaceContainerPath: "/workspaces/run/repo",
      environment: {},
      logger: new RunLogger(directory, "run", []),
      killGraceMs: 50
    });
    await dockerRunner.start(1_000);

    await expect(
      dockerRunner.exec("test slow", "/workspaces/run/repo", { runRemainingMs: 10_000, commandMs: 50 })
    ).rejects.toBeInstanceOf(RunnerTimeoutError);
    expect(runner.groupKills()).toBe(1);
    expect(runner.containerKilled()).toBe(true);
  });
});
