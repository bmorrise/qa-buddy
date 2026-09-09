import { mkdirSync } from "node:fs";
import path from "node:path";
import type { RunLogger } from "./logger.js";
import { ProcessError, runProcess } from "./process.js";

export function githubFetchFailureMessage(tokenConfigured: boolean): string {
  return tokenConfigured
    ? "GitHub fetch failed. Verify that GITHUB_TOKEN can read this repository and that the requested ref exists"
    : "GitHub fetch failed. This repository may be private; set GITHUB_TOKEN in .env and recreate the worker";
}

export async function cloneRepository(options: {
  githubUrl: string;
  ref: string;
  runDirectory: string;
  githubToken?: string;
  logger: RunLogger;
  timeoutMs: () => number;
}): Promise<{ repositoryDirectory: string; resolvedSha: string }> {
  mkdirSync(options.runDirectory, { recursive: true });
  const repositoryDirectory = path.join(options.runDirectory, "repo");
  mkdirSync(repositoryDirectory, { recursive: true });
  const gitEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0"
  };
  if (options.githubToken) {
    gitEnvironment.GITHUB_TOKEN = options.githubToken;
    gitEnvironment.GIT_ASKPASS = process.env.QA_BUDDY_GIT_ASKPASS ?? "/app/docker/git-askpass.sh";
  }

  await runProcess({
    command: "git",
    args: ["init", "--quiet"],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  await runProcess({
    command: "git",
    args: ["remote", "add", "origin", options.githubUrl],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs(),
    display: `git remote add origin ${options.githubUrl}`
  });
  try {
    await runProcess({
      command: "git",
      args: ["fetch", "--depth=1", "origin", options.ref],
      cwd: repositoryDirectory,
      env: gitEnvironment,
      logger: options.logger,
      timeoutMs: options.timeoutMs(),
      display: `git fetch --depth=1 origin ${options.ref}`
    });
  } catch (error) {
    if (error instanceof ProcessError) {
      throw new ProcessError(githubFetchFailureMessage(Boolean(options.githubToken)), error.exitCode);
    }
    throw error;
  }
  await runProcess({
    command: "git",
    args: ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  const revision = await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repositoryDirectory,
    env: gitEnvironment,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });

  return { repositoryDirectory, resolvedSha: revision.stdout.trim() };
}
