import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import {
  parseIstanbulReport,
  parseLcovReport,
  type AppRun,
  type CoverageFileEntry,
  type CoverageFormat,
  type CoverageSummary,
  type RunDetail,
  type TestResults
} from "@qa-buddy/shared";
import { clearAppReports, detectPnpmWorkspaceApps, discoverCoverageReport } from "./detection.js";
import { cleanupOrphanRunners, CommandTimeoutError, DockerRunner, RunnerTimeoutError } from "./docker-runner.js";
import {
  archiveLocalWorkingTree,
  cloneRepository,
  githubAuthenticationMessage,
  githubRegistryAuthenticationMessage
} from "./git.js";
import { RunLogger } from "./logger.js";
import { ProcessError } from "./process.js";
import { executeSliceBuild } from "./slices/build.js";
import { readTestResults } from "./test-results.js";
import {
  APP_TIME_LIMIT_HISTORY,
  appTimeLimit,
  formatMinutes,
  IDLE_TIMEOUT_MS,
  type AppTimeLimit
} from "./timeouts.js";

class SetupError extends Error {}
class BuildError extends Error {}

/** Raised once a stop has been requested so the run ends as interrupted, not failed. */
export class RunCancelledError extends Error {
  constructor() {
    super("Run stopped by request");
  }
}

export interface WorkerOptions {
  database: QaBuddyDatabase;
  docker: Docker;
  dataDirectory: string;
  workspaceDirectory: string;
  workspaceVolume: string;
  /** Container path of the read-only host bind mount holding local checkouts. */
  localSourceDirectory?: string;
  githubToken?: string;
  historyLimit: number;
  pollIntervalMs?: number;
  /** How often an in-flight run checks whether a stop has been requested. */
  cancellationPollMs?: number;
  /** Overrides the hung-command timeout; tests use a short one. */
  idleTimeoutMs?: number;
  /** Overrides how each app's time limit is derived from its history. */
  appTimeLimit?: (recentPassingDurationsMs: number[]) => AppTimeLimit;
}

export type CoverageSnapshotSkipReason = "no-coverage" | "local-working-tree" | "no-files";

export const coverageSkipMessages: Record<CoverageSnapshotSkipReason, string> = {
  "no-coverage": "this app produced no usable coverage report",
  "local-working-tree": "local working tree runs never overwrite the snapshot",
  "no-files": "the coverage report contained no per-file entries"
};

/**
 * Decides whether a finished app run may replace the stored coverage snapshot.
 * Returns the reason to skip, or null to record it.
 */
export function coverageSnapshotSkipReason(options: {
  useLocalWorkingTree: boolean;
  hasCoverage: boolean;
  fileCount: number;
}): CoverageSnapshotSkipReason | null {
  if (!options.hasCoverage) return "no-coverage";
  if (options.useLocalWorkingTree) return "local-working-tree";
  if (options.fileCount === 0) return "no-files";
  return null;
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
    const failedBuilds = this.options.database.markActiveSliceBuildsFailed();
    if (failedBuilds.length) console.info(`Failed ${failedBuilds.length} slice build(s) interrupted by a restart`);
  }

  async run(): Promise<void> {
    await this.initialize();
    while (!this.stopping) {
      const run = this.options.database.claimNextRun();
      if (run) {
        await this.executeRun(run);
        continue;
      }
      // Test runs take priority; slice builds only read source and finish quickly.
      const sliceBuild = this.options.database.claimNextSliceBuild();
      if (sliceBuild) {
        await executeSliceBuild(sliceBuild, this.options);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 1_000));
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
  ): {
    coverage: CoverageSummary;
    coverageFiles: CoverageFileEntry[];
    coverageFormat: CoverageFormat;
    coveragePath: string;
  } {
    const reportPath = path.resolve(repositoryDirectory, appRun.coveragePath);
    const repositoryRoot = path.resolve(repositoryDirectory);
    if (reportPath !== repositoryRoot && !reportPath.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error("Coverage report path escaped the repository checkout");
    }
    if (!existsSync(reportPath)) {
      throw new Error(`Coverage report was not created at ${appRun.coveragePath}`);
    }
    const contents = readFileSync(reportPath, "utf8");
    const parseOptions = {
      rootDirectory: repositoryDirectory,
      workingDirectory: appRun.workingDirectory
    };
    const report =
      appRun.coverageFormat === "lcov"
        ? parseLcovReport(contents, parseOptions)
        : parseIstanbulReport(contents, parseOptions);
    return {
      coverage: report.summary,
      coverageFiles: report.files,
      coverageFormat: appRun.coverageFormat,
      coveragePath: appRun.coveragePath
    };
  }


  /**
   * Replaces this app's per-file coverage snapshot. Local working tree runs are
   * skipped so an uncommitted checkout never overwrites the baseline captured
   * from a commit that exists on the remote.
   */
  private recordCoverageSnapshot(
    run: RunDetail,
    appRun: AppRun,
    logger: RunLogger,
    resolvedSha: string,
    result: {
      coverage: CoverageSummary | null;
      coverageFiles: CoverageFileEntry[];
      coverageFormat?: CoverageFormat;
      coveragePath?: string;
    }
  ): void {
    const skip = coverageSnapshotSkipReason({
      useLocalWorkingTree: run.useLocalWorkingTree,
      hasCoverage: Boolean(result.coverage && result.coverageFormat),
      fileCount: result.coverageFiles.length
    });
    if (skip) {
      if (skip !== "no-coverage") {
        logger.line(`${appRun.name} coverage snapshot not updated: ${coverageSkipMessages[skip]}`);
      }
      return;
    }
    try {
      this.options.database.replaceCoverageSnapshot(run.repositoryId, appRun.name, {
        runId: run.id,
        resolvedSha,
        coverageFormat: result.coverageFormat!,
        coveragePath: result.coveragePath ?? null,
        summary: result.coverage!,
        files: result.coverageFiles
      });
      logger.line(`Updated the ${appRun.name} coverage snapshot with ${result.coverageFiles.length} files`);
    } catch (error) {
      logger.line(
        `Unable to update the ${appRun.name} coverage snapshot: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  /**
   * Adds this run's point to every slice that reaches a backend the run tested.
   * Unlike the snapshot, local working tree runs are recorded and flagged,
   * matching app coverage history.
   */
  private recordSliceHistory(
    run: RunDetail,
    logger: RunLogger,
    source: { resolvedSha: string; dirty: boolean },
    filesByDirectory: Map<string, CoverageFileEntry[]>
  ): void {
    try {
      const written = this.options.database.recordSliceHistory({
        repositoryId: run.repositoryId,
        runId: run.id,
        requestedRef: run.requestedRef,
        resolvedSha: source.resolvedSha,
        useLocalWorkingTree: run.useLocalWorkingTree,
        dirty: source.dirty,
        filesByDirectory
      });
      if (written) logger.line(`Recorded coverage for ${written} slice${written === 1 ? "" : "s"}`);
    } catch (error) {
      logger.line(`Unable to record slice coverage: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private safeRunDirectory(runId: string): string {
    const root = path.resolve(this.options.workspaceDirectory);
    const runDirectory = path.resolve(root, runId);
    if (path.dirname(runDirectory) !== root) throw new Error("Invalid run workspace path");
    return runDirectory;
  }

  private async archiveLocalSource(
    run: RunDetail,
    runDirectory: string,
    logger: RunLogger,
    deadline: number
  ): Promise<{ repositoryDirectory: string; resolvedSha: string; dirty: boolean }> {
    const localSourceDirectory = this.options.localSourceDirectory;
    if (!localSourceDirectory) {
      throw new Error(
        "Local working tree runs are not enabled. Set QA_BUDDY_LOCAL_SOURCE_ROOT in .env and recreate the worker."
      );
    }
    const localPath = run.configurationSnapshot.localPath;
    if (!localPath) {
      throw new Error("This repository has no local checkout path configured");
    }
    return await archiveLocalWorkingTree({
      localSourceDirectory,
      localPath,
      runDirectory,
      logger,
      timeoutMs: () => this.remaining(deadline)
    });
  }

  private async executeRun(run: RunDetail): Promise<void> {
    const environment = this.runnerEnvironment(run);
    const logger = new RunLogger(this.options.dataDirectory, run.id, [
      this.options.githubToken,
      process.env.GITHUB_IDP_REGISTRY,
      ...Object.values(environment)
    ]);
    const runDirectory = this.safeRunDirectory(run.id);
    const deadline = Date.now() + run.configurationSnapshot.timeoutMinutes * 60_000;
    let repositoryDirectory = "";
    let appFailures = 0;
    let appTimeouts = 0;
    let appRuns = run.appRuns;
    let cancelled = false;
    // Per-file coverage by app directory, so slices spanning several backends
    // get one point per run built from all of them.
    const sliceCoverage = new Map<string, CoverageFileEntry[]>();
    let sliceSource: { resolvedSha: string; dirty: boolean } | null = null;

    // Polled rather than pushed: the server and worker are separate processes
    // that share only SQLite.
    const cancellationPoll = setInterval(() => {
      if (cancelled) return;
      try {
        if (!this.options.database.isCancellationRequested(run.id)) return;
      } catch {
        return; // A transient read failure should not end the run.
      }
      cancelled = true;
      logger.line("Stop requested; terminating the runner");
      void this.activeRunner?.stop().catch(() => undefined);
    }, this.options.cancellationPollMs ?? 1_000);
    const ensureRunning = (): void => {
      if (cancelled) throw new RunCancelledError();
    };

    logger.line(`Run ${run.id} queued for ${run.configurationSnapshot.githubUrl}`);
    logger.line(
      run.useLocalWorkingTree
        ? `Source: local working tree at ${run.configurationSnapshot.localPath}`
        : `Requested ref: ${run.requestedRef}`
    );
    logger.line(
      run.configurationSnapshot.selectedApps
        ? `Selected apps: ${run.configurationSnapshot.selectedApps.join(", ")}`
        : "Selected apps: all detected or configured apps"
    );
    logger.line(githubAuthenticationMessage(this.options.githubToken));
    logger.line(githubRegistryAuthenticationMessage(process.env.GITHUB_IDP_REGISTRY));
    if (process.env.GITHUB_IDP_REGISTRY && !environment.GITHUB_IDP_REGISTRY) {
      logger.line("GITHUB_IDP_REGISTRY is not passed to this run; add it to the repository's environment allowlist to enable package authentication.");
    }

    try {
      const source = run.useLocalWorkingTree
        ? await this.archiveLocalSource(run, runDirectory, logger, deadline)
        : {
            ...(await cloneRepository({
              githubUrl: run.configurationSnapshot.githubUrl,
              ref: run.requestedRef,
              runDirectory,
              githubToken: this.options.githubToken,
              logger,
              timeoutMs: () => this.remaining(deadline)
            })),
            dirty: false
          };
      ensureRunning();
      repositoryDirectory = source.repositoryDirectory;
      sliceSource = source;
      this.options.database.updateRun(run.id, {
        resolvedSha: source.resolvedSha,
        dirty: source.dirty
      });
      logger.line(
        source.dirty
          ? `Resolved commit: ${source.resolvedSha} plus uncommitted local changes (not reproducible)`
          : `Resolved commit: ${source.resolvedSha}`
      );

      if (run.configurationSnapshot.autoDetect) {
        const detection = await detectPnpmWorkspaceApps(
          repositoryDirectory,
          run.configurationSnapshot.testWorkerLimit,
          run.configurationSnapshot.additionalWorkspaces ?? [],
          run.configurationSnapshot.excludedWorkspaces ?? []
        );
        logger.line(
          `Detected ${detection.apps.length} testable app${detection.apps.length === 1 ? "" : "s"} across ${detection.workspaceCount} pnpm workspace${detection.workspaceCount === 1 ? "" : "s"}${detection.hasTurbo ? " with turbo.json" : ""}`
        );
        logger.line(`Auto-detected test worker limit: ${run.configurationSnapshot.testWorkerLimit}`);
        if (detection.excluded.length) {
          logger.line(`Excluded workspaces: ${detection.excluded.join(", ")}`);
        }
        if (detection.unmatchedExclusions.length) {
          logger.line(
            `Warning: excluded workspaces not found in this repository, ignoring: ${detection.unmatchedExclusions.join(", ")}`
          );
        }
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
        const setup = await this.activeRunner.exec(run.configurationSnapshot.setupCommand, workspaceContainerPath, {
          runRemainingMs: this.remaining(deadline),
          idleMs: this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
        });
        ensureRunning();
        if (setup.exitCode !== 0) {
          throw new SetupError(`Setup command exited with code ${setup.exitCode}`);
        }
      }

      if (run.configurationSnapshot.buildCommand) {
        this.options.database.updateRun(run.id, { status: "building" });
        logger.line("Building repository before tests");
        const build = await this.activeRunner.exec(run.configurationSnapshot.buildCommand, workspaceContainerPath, {
          runRemainingMs: this.remaining(deadline),
          idleMs: this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
        });
        ensureRunning();
        if (build.exitCode !== 0) {
          throw new BuildError(`Build command exited with code ${build.exitCode}`);
        }
      }

      this.options.database.updateRun(run.id, { status: "testing" });
      const passingDurations = this.options.database.recentPassingAppDurations(
        run.repositoryId,
        APP_TIME_LIMIT_HISTORY
      );
      for (const appRun of appRuns) {
        ensureRunning();
        this.options.database.startAppRun(appRun.id);
        const timeLimit = (this.options.appTimeLimit ?? appTimeLimit)(passingDurations.get(appRun.name) ?? []);
        logger.line(`Testing ${appRun.name} (time limit ${formatMinutes(timeLimit.limitMs)}: ${timeLimit.basis})`);
        let exitCode = 1;
        let coverage: CoverageSummary | null = null;
        let coverageFormat: CoverageFormat | undefined;
        let coveragePath: string | undefined;
        let coverageError: string | null = null;
        let coverageFiles: CoverageFileEntry[] = [];
        let testResults: TestResults | null = null;
        let testResultsError: string | null = null;
        try {
          clearAppReports(repositoryDirectory, appRun.workingDirectory, appRun.coveragePath);
          const result = await this.activeRunner.exec(
            appRun.testCommand,
            path.posix.join(workspaceContainerPath, appRun.workingDirectory),
            {
              runRemainingMs: this.remaining(deadline),
              idleMs: this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
              commandMs: timeLimit.limitMs
            }
          );
          ensureRunning();
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
            coverageFiles = discovered.coverageFiles;
            coverageFormat = discovered.coverageFormat;
            coveragePath = discovered.coveragePath;
          } catch (error) {
            coverageError = error instanceof Error ? error.message : "Unable to parse coverage report";
            logger.line(`${appRun.name} coverage error: ${coverageError}`);
          }
        } catch (error) {
          // A stop request kills the runner, which can surface here as a timeout.
          ensureRunning();
          if (error instanceof RunnerTimeoutError || error instanceof RunCancelledError) throw error;
          coverageError = error instanceof Error ? error.message : "Test command failed to execute";
          if (error instanceof CommandTimeoutError) {
            appTimeouts += 1;
            logger.line(`${appRun.name} timed out: ${coverageError}; continuing with the next app`);
          } else {
            logger.line(`${appRun.name} command error: ${coverageError}`);
          }
        }

        // A suite that ran cleanly with nothing to run (for example a package
        // mid-migration using --passWithNoTests) is skipped rather than failed,
        // and its empty coverage never reaches the snapshot.
        const ranNoTests = exitCode === 0 && testResults !== null && testResults.total === 0;
        if (ranNoTests) {
          logger.line(`${appRun.name} reported no tests; skipping it without failing the run`);
          this.options.database.finishAppRun(appRun.id, {
            status: "skipped",
            exitCode,
            coverage: null,
            testResults,
            testResultsError: null,
            coverageError: "No tests were found in this workspace"
          });
          continue;
        }

        const passed = exitCode === 0 && coverage !== null;
        if (!passed) appFailures += 1;
        this.recordCoverageSnapshot(run, appRun, logger, source.resolvedSha, {
          coverage,
          coverageFiles,
          coverageFormat,
          coveragePath
        });
        if (coverageFiles.length) sliceCoverage.set(appRun.workingDirectory, coverageFiles);
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
          error: `${appFailures} app${appFailures === 1 ? "" : "s"} did not produce a passing test and coverage result${appTimeouts > 0 ? ` (${appTimeouts} timed out)` : ""}`,
          finished: true
        });
      } else {
        this.options.database.updateRun(run.id, { status: "passed", error: null, finished: true });
      }
    } catch (error) {
      if (error instanceof RunCancelledError) {
        // A deliberate stop is not a failure; apps that never ran are skipped.
        logger.line("Run stopped by request");
        this.options.database.skipPendingApps(run.id, "Run stopped by request");
        this.options.database.updateRun(run.id, {
          status: "interrupted",
          error: "Run stopped by request",
          finished: true
        });
      } else {
        const timedOut =
          error instanceof RunnerTimeoutError ||
          error instanceof CommandTimeoutError ||
          (error instanceof ProcessError && error.exitCode === null);
        const message = error instanceof Error ? error.message : "Run failed unexpectedly";
        logger.line(`${timedOut ? "Timeout" : "Run failure"}: ${message}`);
        this.options.database.skipPendingApps(run.id, message);
        this.options.database.updateRun(run.id, {
          status: timedOut ? "timed_out" : "failed",
          error: message,
          finished: true
        });
      }
    } finally {
      clearInterval(cancellationPoll);
      if (sliceSource && sliceCoverage.size) this.recordSliceHistory(run, logger, sliceSource, sliceCoverage);
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
