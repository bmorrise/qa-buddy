import { rmSync } from "node:fs";
import path from "node:path";
import type { QaBuddyDatabase } from "@qa-buddy/db";
import type { SliceBuild } from "@qa-buddy/shared";
import { archiveLocalWorkingTree, cloneRepository } from "../git.js";
import { RunLogger } from "../logger.js";
import { analyzeSlices } from "./analyze.js";

/** Slice builds only read source, so a generous fixed cap is enough. */
const SLICE_BUILD_TIMEOUT_MS = 15 * 60_000;
export const SLICE_BUILD_HISTORY_LIMIT = 10;

export function sliceBuildLogName(buildId: string): string {
  return `slice-build-${buildId}`;
}

export interface SliceBuildOptions {
  database: QaBuddyDatabase;
  dataDirectory: string;
  workspaceDirectory: string;
  localSourceDirectory?: string;
  githubToken?: string;
}

/**
 * Checks out the repository (from GitHub or the local working tree), traces
 * every configured frontend to the backend files it depends on, and replaces
 * the repository's slices. Nothing is installed or built.
 */
export async function executeSliceBuild(build: SliceBuild, options: SliceBuildOptions): Promise<void> {
  const { database } = options;
  const logger = new RunLogger(options.dataDirectory, sliceBuildLogName(build.id), [options.githubToken]);
  const root = path.resolve(options.workspaceDirectory);
  const buildDirectory = path.resolve(root, `slices-${build.id}`);
  if (path.dirname(buildDirectory) !== root) throw new Error("Invalid slice build workspace path");
  const deadline = Date.now() + SLICE_BUILD_TIMEOUT_MS;
  const timeoutMs = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Slice build exceeded its time limit");
    return remaining;
  };

  try {
    const repository = database.getRepository(build.repositoryId);
    if (!repository) throw new Error("Repository no longer exists");
    logger.line(`Slice build ${build.id} for ${repository.name}`);

    let source: { repositoryDirectory: string; resolvedSha: string; dirty: boolean };
    if (build.useLocalWorkingTree) {
      if (!options.localSourceDirectory || !repository.localPath) {
        throw new Error("Local working tree builds need QA_BUDDY_LOCAL_SOURCE_ROOT and a local checkout path");
      }
      source = await archiveLocalWorkingTree({
        localSourceDirectory: options.localSourceDirectory,
        localPath: repository.localPath,
        runDirectory: buildDirectory,
        logger,
        timeoutMs
      });
    } else {
      source = {
        ...(await cloneRepository({
          githubUrl: repository.githubUrl,
          ref: build.requestedRef,
          runDirectory: buildDirectory,
          githubToken: options.githubToken,
          logger,
          timeoutMs
        })),
        dirty: false
      };
    }
    database.setSliceBuildSource(build.id, source.resolvedSha, source.dirty);
    logger.line(`Resolved commit: ${source.resolvedSha}${source.dirty ? " plus uncommitted local changes" : ""}`);

    const { config } = build;
    const targets = config.frontendDirectories.length
      ? config.frontendDirectories.map((directory) => ({ name: path.posix.basename(directory), frontendDirectory: directory }))
      : null;
    const result = await analyzeSlices(
      source.repositoryDirectory,
      targets,
      config.backends.map((backend) => ({
        directory: backend.directory,
        framework: backend.framework,
        clientPackage: backend.clientPackage ?? undefined,
        rootModule: backend.rootModule ?? undefined,
        entryFile: backend.entryFile ?? undefined,
        baseUrlNames: backend.baseUrlNames
      }))
    );
    for (const slice of result.slices) {
      const parts = slice.backends.map((backend) => `${backend.directory} ${backend.endpointCount} endpoints / ${backend.files.length} files`);
      logger.line(`Sliced ${slice.frontendDirectory}: ${parts.join("; ")}`);
      for (const call of slice.unmatchedCalls) {
        logger.line(`  Unmatched ${call.method?.toUpperCase() ?? "request"} ${call.path} to ${call.backendDirectory} at ${call.site}`);
      }
    }
    for (const skipped of result.skipped) {
      logger.line(`Skipped ${skipped.frontendDirectory}: ${skipped.reason}`);
    }
    if (result.slices.length === 0) {
      throw new Error(
        targets
          ? "None of the configured frontends could be sliced"
          : "No apps/* workspace depends on a configured client package; list the frontends to slice explicitly"
      );
    }

    database.replaceSlices(
      build.repositoryId,
      build.id,
      source.resolvedSha,
      result.slices.map((slice) => ({
        name: slice.name,
        frontendDirectory: slice.frontendDirectory,
        endpoints: slice.endpoints.map(({ ambiguous: _ambiguous, ...endpoint }) => endpoint),
        backends: slice.backends,
        unmatchedCalls: slice.unmatchedCalls
      }))
    );
    database.finishSliceBuild(build.id, { status: "passed", sliceCount: result.slices.length, skipped: result.skipped });
    logger.line(`Stored ${result.slices.length} slices`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slice build failed unexpectedly";
    logger.line(`Slice build failed: ${message}`);
    database.finishSliceBuild(build.id, { status: "failed", error: message });
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true });
    for (const removed of database.pruneSliceBuilds(build.repositoryId, SLICE_BUILD_HISTORY_LIMIT)) {
      rmSync(path.join(options.dataDirectory, "logs", `${sliceBuildLogName(removed)}.log`), { force: true });
    }
  }
}
