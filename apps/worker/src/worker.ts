import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import {
  parseIstanbulSummary,
  parseLcov,
  type AppRun,
  type CoverageFormat,
  type CoverageSummary,
  type RunDetail,
  type TestResults
} from "@qa-buddy/shared";
import { clearAppReports, detectPnpmWorkspaceApps, discoverCoverageReport } from "./detection.js";
import { cleanupOrphanRunners, DockerRunner, RunnerTimeoutError } from "./docker-runner.js";
import { cloneRepository, githubAuthenticationMessage } from "./git.js";
import { RunLogger } from "./logger.js";
import { ProcessError } from "./process.js";
import { readTestResults } from "./test-results.js";

class SetupError extends Error {}
class BuildError extends Error {}

export interface WorkerOptions {
  database: QaBuddyDatabase;
  docker: Docker;
  dataDirectory: string;
  workspaceDirectory: string;
  workspaceVolume: string;
  githubToken?: string;
  historyLimit: number;
  pollIntervalMs?: number;
}

export class QaBuddyWorker {
  private stopping = false;
  private activeRunner: DockerRunner | null = null;

  constructor(private readonly options: WorkerOptions) {}

  async initialize(): Promise<void> {
    const cleaned = await cleanupOrphanRunners(this.options.docker);
    const interrupted = this.options.database.markActiveRunsInterrupted();
    if (cleaned || interrupted.length) {
      console.info(`Recovered ${cleaned} runner container(s) and ${interrupted.length} interrupted run(s)`);
    }
  }

  async run(): Promise<void> {
    await this.initialize();
    while (!this.stopping) {
      const run = this.options.database.claimNextRun();
      if (run) {
        await this.executeRun(run);
      } else {
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 1_000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.activeRunner) {
      await this.activeRunner.remove().catch(() => undefined);
    }
  }

  private remaining(deadline: number): number {
    const value = deadline - Date.now();
    if (value <= 0) throw new RunnerTimeoutError("Repository run exceeded its configured timeout");
    return value;
  }

  private runnerEnvironment(run: RunDetail): Record<string, string> {
    return Object.fromEntries(
      run.configurationSnapshot.environmentAllowlist
        .filter((name) => name !== "GITHUB_TOKEN")
        .map((name) => [name, process.env[name]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    );
  }

  private parseCoverage(
    repositoryDirectory: string,
    appRun: AppRun
  ): { coverage: CoverageSummary; coverageFormat: CoverageFormat; coveragePath: string } {
    const reportPath = path.resolve(repositoryDirectory, appRun.coveragePath);
    const repositoryRoot = path.resolve(repositoryDirectory);
    if (reportPath !== repositoryRoot && !reportPath.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error("Coverage report path escaped the repository checkout");
    }
    if (!existsSync(reportPath)) {
      throw new Error(`Coverage report was not created at ${appRun.coveragePath}`);
    }
    const contents = readFileSync(reportPath, "utf8");
    return {
      coverage: appRun.coverageFormat === "lcov" ? parseLcov(contents) : parseIstanbulSummary(contents),
      coverageFormat: appRun.coverageFormat,
      coveragePath: appRun.coveragePath
    };
  }

  private safeRunDirectory(runId: string): string {
    const root = path.resolve(this.options.workspaceDirectory);
    const runDirectory = path.resolve(root, runId);
    if (path.dirname(runDirectory) !== root) throw new Error("Invalid run workspace path");
    return runDirectory;
  }

  private async executeRun(run: RunDetail): Promise<void> {
    const environment = this.runnerEnvironment(run);
    const logger = new RunLogger(this.options.dataDirectory, run.id, [
      this.options.githubToken,
      ...Object.values(environment)
    ]);
    const runDirectory = this.safeRunDirectory(run.id);
    const deadline = Date.now() + run.configurationSnapshot.timeoutMinutes * 60_000;
    let repositoryDirectory = "";
    let appFailures = 0;
    let appRuns = run.appRuns;

    logger.line(`Run ${run.id} queued for ${run.configurationSnapshot.githubUrl}`);
    logger.line(`Requested ref: ${run.requestedRef}`);
    logger.line(
      run.configurationSnapshot.selectedApps
        ? `Selected apps: ${run.configurationSnapshot.selectedApps.join(", ")}`
        : "Selected apps: all detected or configured apps"
    );
    logger.line(githubAuthenticationMessage(this.options.githubToken));

    try {
      const clone = await cloneRepository({
        githubUrl: run.configurationSnapshot.githubUrl,
        ref: run.requestedRef,
        runDirectory,
        githubToken: this.options.githubToken,
        logger,
        timeoutMs: () => this.remaining(deadline)
      });
      repositoryDirectory = clone.repositoryDirectory;
      this.options.database.updateRun(run.id, { resolvedSha: clone.resolvedSha });
      logger.line(`Resolved commit: ${clone.resolvedSha}`);

      if (run.configurationSnapshot.autoDetect) {
        const detection = await detectPnpmWorkspaceApps(
          repositoryDirectory,
          run.configurationSnapshot.testWorkerLimit
        );
        logger.line(
          `Detected ${detection.apps.length} testable app${detection.apps.length === 1 ? "" : "s"} across ${detection.workspaceCount} pnpm workspace${detection.workspaceCount === 1 ? "" : "s"}${detection.hasTurbo ? " with turbo.json" : ""}`
        );
        logger.line(`Auto-detected test worker limit: ${run.configurationSnapshot.testWorkerLimit}`);
        for (const app of detection.apps) {
          logger.line(`Detected app ${app.name} at ${app.workingDirectory} using ${app.testCommand}`);
        }
        appRuns = this.options.database.setDetectedApps(run.id, detection.apps).appRuns;
        if (run.configurationSnapshot.selectedApps) {
          logger.line(`Running ${appRuns.length} selected app${appRuns.length === 1 ? "" : "s"}: ${appRuns.map((app) => app.name).join(", ")}`);
        }
      }

      const workspaceContainerPath = `/workspaces/${run.id}/repo`;
      this.activeRunner = new DockerRunner(this.options.docker, {
        runId: run.id,
        image: run.configurationSnapshot.runnerImage,
        workspaceVolume: this.options.workspaceVolume,
        workspaceContainerPath,
        environment,
        logger
      });
      await this.activeRunner.start(this.remaining(deadline));

      if (run.configurationSnapshot.setupCommand) {
        this.options.database.updateRun(run.id, { status: "setup" });
        logger.line("Running repository setup");
        const setup = await this.activeRunner.exec(
          run.configurationSnapshot.setupCommand,
          workspaceContainerPath,
          this.remaining(deadline)
        );
        if (setup.exitCode !== 0) {
          throw new SetupError(`Setup command exited with code ${setup.exitCode}`);
        }
      }

      if (run.configurationSnapshot.buildCommand) {
        this.options.database.updateRun(run.id, { status: "building" });
        logger.line("Building repository before tests");
        const build = await this.activeRunner.exec(
          run.configurationSnapshot.buildCommand,
          workspaceContainerPath,
          this.remaining(deadline)
        );
        if (build.exitCode !== 0) {
          throw new BuildError(`Build command exited with code ${build.exitCode}`);
        }
      }

      this.options.database.updateRun(run.id, { status: "testing" });
      for (const appRun of appRuns) {
        this.options.database.startAppRun(appRun.id);
        logger.line(`Testing ${appRun.name}`);
        let exitCode = 1;
        let coverage: CoverageSummary | null = null;
        let coverageFormat: CoverageFormat | undefined;
        let coveragePath: string | undefined;
        let coverageError: string | null = null;
        let testResults: TestResults | null = null;
        let testResultsError: string | null = null;
        try {
          clearAppReports(repositoryDirectory, appRun.workingDirectory, appRun.coveragePath);
          const result = await this.activeRunner.exec(
            appRun.testCommand,
            path.posix.join(workspaceContainerPath, appRun.workingDirectory),
            this.remaining(deadline)
          );
          exitCode = result.exitCode;
          try {
            testResults = readTestResults(repositoryDirectory, appRun.workingDirectory);
            if (testResults) {
              logger.line(
                `${appRun.name} test cases: ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped, ${testResults.todo} todo`
              );
            } else {
              testResultsError = "Structured Jest/Vitest test report was not produced";
            }
          } catch (error) {
            testResultsError = error instanceof Error ? error.message : "Unable to parse structured test report";
            logger.line(`${appRun.name} test result error: ${testResultsError}`);
          }
          try {
            const discovered = run.configurationSnapshot.autoDetect
              ? discoverCoverageReport(
                  repositoryDirectory,
                  appRun.workingDirectory,
                  appRun.coveragePath
                )
              : this.parseCoverage(repositoryDirectory, appRun);
            coverage = discovered.coverage;
            coverageFormat = discovered.coverageFormat;
            coveragePath = discovered.coveragePath;
          } catch (error) {
            coverageError = error instanceof Error ? error.message : "Unable to parse coverage report";
            logger.line(`${appRun.name} coverage error: ${coverageError}`);
          }
        } catch (error) {
          if (error instanceof RunnerTimeoutError) throw error;
          coverageError = error instanceof Error ? error.message : "Test command failed to execute";
          logger.line(`${appRun.name} command error: ${coverageError}`);
        }

        const passed = exitCode === 0 && coverage !== null;
        if (!passed) appFailures += 1;
        this.options.database.finishAppRun(appRun.id, {
          status: passed ? "passed" : "failed",
          exitCode,
          coverage,
          coverageFormat,
          coveragePath,
          testResults,
          testResultsError,
          coverageError: coverageError ?? (exitCode === 0 ? null : `Test command exited with code ${exitCode}`)
        });
      }

      if (appFailures > 0) {
        this.options.database.updateRun(run.id, {
          status: "failed",
          error: `${appFailures} app${appFailures === 1 ? "" : "s"} did not produce a passing test and coverage result`,
          finished: true
        });
      } else {
        this.options.database.updateRun(run.id, { status: "passed", error: null, finished: true });
      }
    } catch (error) {
      const timedOut = error instanceof RunnerTimeoutError || (error instanceof ProcessError && error.exitCode === null);
      const message = error instanceof Error ? error.message : "Run failed unexpectedly";
      logger.line(`${timedOut ? "Timeout" : "Run failure"}: ${message}`);
      this.options.database.skipPendingApps(run.id, message);
      this.options.database.updateRun(run.id, {
        status: timedOut ? "timed_out" : "failed",
        error: message,
        finished: true
      });
    } finally {
      if (this.activeRunner) {
        try {
          await this.activeRunner.remove();
          logger.line("Removed runner container");
        } catch (error) {
          logger.line(`Unable to remove runner container: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        this.activeRunner = null;
      }
      rmSync(runDirectory, { recursive: true, force: true });
      logger.line("Removed temporary checkout");

      const removedRunIds = this.options.database.pruneRuns(run.repositoryId, this.options.historyLimit);
      for (const runId of removedRunIds) {
        rmSync(path.join(this.options.dataDirectory, "logs", `${runId}.log`), { force: true });
      }
    }
  }
}
