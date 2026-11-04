import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyDatabase } from "@qa-buddy/db";
import type { RepositoryInput } from "@qa-buddy/shared";
import { executeSliceBuild, sliceBuildLogName } from "./build.js";
import { CLIENT, EXPRESS_BACKEND, writeFixture } from "./test-fixture.js";

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

const repositoryInput: RepositoryInput = {
  name: "Fixture",
  githubUrl: "https://github.com/example/fixture.git",
  defaultRef: "main",
  localPath: "fixture",
  additionalWorkspaces: [],
  excludedWorkspaces: [],
  runnerImage: "node:22-bookworm",
  testWorkerLimit: 2,
  timeoutMinutes: 30,
  environmentAllowlist: [],
  autoDetect: true,
  apps: []
};

describe("slice builds", () => {
  let root: string;
  let database: QaBuddyDatabase;
  let repositoryId: string;
  const options = () => ({
    database,
    dataDirectory: path.join(root, "data"),
    workspaceDirectory: path.join(root, "workspaces"),
    localSourceDirectory: path.join(root, "source")
  });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "qa-buddy-slice-build-"));
    const checkout = path.join(root, "source", "fixture");
    writeFixture(checkout);
    git(checkout, "init", "--quiet", "--initial-branch=main");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "fixture");
    database = new QaBuddyDatabase(path.join(root, "data", "test.sqlite"));
    repositoryId = database.createRepository(repositoryInput).id;
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("traces the configured frontends from a checkout and stores the slices", async () => {
    database.setSliceConfig(repositoryId, {
      backends: [
        { directory: "apps/api", framework: "nestjs", clientPackage: CLIENT, rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] },
        { ...EXPRESS_BACKEND, clientPackage: null, rootModule: null }
      ],
      frontendDirectories: ["apps/inspect", "apps/scout", "apps/gone"]
    });
    const build = database.createSliceBuild(repositoryId, undefined, true);
    await executeSliceBuild(database.claimNextSliceBuild()!, options());

    const finished = database.getSliceBuild(build.id)!;
    expect(finished).toMatchObject({
      status: "passed",
      sliceCount: 2,
      skipped: [{ frontendDirectory: "apps/gone", reason: "not a pnpm workspace in this repository" }]
    });
    expect(finished.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    const slices = database.listSlices(repositoryId);
    expect(slices.map((slice) => [slice.name, slice.endpointCount, slice.backends.map((backend) => [backend.directory, backend.endpointCount, backend.fileCount])])).toEqual([
      ["inspect", 8, [["apps/api", 3, 4], ["apps/legacy", 5, 7]]],
      ["scout", 2, [["apps/api", 2, 2], ["apps/legacy", 0, 0]]]
    ]);
    expect(database.getSlice(repositoryId, "inspect")!.unmatchedCalls).toEqual([
      { backendDirectory: "apps/legacy", site: "apps/inspect/src/legacy-calls.ts:13", method: "patch", path: "/nowhere/{}" }
    ]);
    expect(database.getSlice(repositoryId, "inspect")!.endpoints[0]).not.toHaveProperty("ambiguous");
    expect(readFileSync(path.join(root, "data", "logs", `${sliceBuildLogName(build.id)}.log`), "utf8")).toContain(
      "Sliced apps/inspect: apps/api 3 endpoints / 4 files; apps/legacy 5 endpoints / 7 files"
    );
    // The temporary checkout is always removed.
    expect(existsSync(path.join(root, "workspaces")) ? readdirSync(path.join(root, "workspaces")) : []).toEqual([]);
  });

  it("fails the build with a clear reason and keeps the previous slices", async () => {
    database.replaceSlices(repositoryId, "earlier", "abc", [
      { name: "inspect", frontendDirectory: "apps/inspect", endpoints: [], backends: [{ directory: "apps/api", endpointCount: 0, files: ["apps/api/src/x.ts"] }] }
    ]);
    database.setSliceConfig(repositoryId, {
      backends: [{ directory: "apps/missing-api", framework: "nestjs", clientPackage: CLIENT, rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] }],
      frontendDirectories: []
    });
    const build = database.createSliceBuild(repositoryId, undefined, true);
    await executeSliceBuild(database.claimNextSliceBuild()!, options());

    expect(database.getSliceBuild(build.id)).toMatchObject({
      status: "failed",
      error: "apps/missing-api is not a pnpm workspace in this repository"
    });
    expect(database.listSlices(repositoryId).map((slice) => slice.buildId)).toEqual(["earlier"]);
  });

  it("explains when no app depends on the client package", async () => {
    database.setSliceConfig(repositoryId, {
      backends: [{ directory: "apps/api", framework: "nestjs", clientPackage: CLIENT, rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] }],
      frontendDirectories: []
    });
    const build = database.createSliceBuild(repositoryId, undefined, true);
    await executeSliceBuild(database.claimNextSliceBuild()!, options());
    expect(database.getSliceBuild(build.id)?.error).toBe(
      "No apps/* workspace depends on a configured client package; list the frontends to slice explicitly"
    );
  });
});
