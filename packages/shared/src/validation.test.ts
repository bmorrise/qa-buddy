import { describe, expect, it } from "vitest";
import {
  isSafeGitRef,
  isSafeRelativePath,
  normalizeGithubUrl,
  repositoryInputSchema,
  runRequestSchema
} from "./validation.js";

describe("repository validation", () => {
  it("normalizes GitHub HTTPS URLs", () => {
    expect(normalizeGithubUrl(" https://github.com/openai/codex/ ")).toBe(
      "https://github.com/openai/codex.git"
    );
    expect(normalizeGithubUrl("https://github.com/openai/codex.git")).toBe(
      "https://github.com/openai/codex.git"
    );
  });

  it("rejects non-GitHub and credential-bearing URLs", () => {
    expect(() => normalizeGithubUrl("git@github.com:openai/codex.git")).toThrow(/GitHub HTTPS/);
    expect(() => normalizeGithubUrl("https://token@github.com/openai/codex")).toThrow(/GitHub HTTPS/);
    expect(() => normalizeGithubUrl("https://example.com/openai/codex")).toThrow(/GitHub HTTPS/);
  });

  it("keeps repository paths inside the checkout", () => {
    expect(isSafeRelativePath(".", true)).toBe(true);
    expect(isSafeRelativePath("apps/web")).toBe(true);
    expect(isSafeRelativePath("../secret")).toBe(false);
    expect(isSafeRelativePath("apps/../secret")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("apps\\web")).toBe(false);
  });

  it("accepts normal refs and rejects unsafe or ambiguous refs", () => {
    expect(isSafeGitRef("main")).toBe(true);
    expect(isSafeGitRef("feature/CLOUD-123")).toBe(true);
    expect(isSafeGitRef("86a3e29d8e9d")).toBe(true);
    expect(isSafeGitRef("--upload-pack=bad")).toBe(false);
    expect(isSafeGitRef("main branch")).toBe(false);
    expect(isSafeGitRef("feature..old")).toBe(false);
  });

  it("rejects duplicate app and environment names", () => {
    const result = repositoryInputSchema.safeParse({
      name: "Platform",
      githubUrl: "https://github.com/example/platform",
      defaultRef: "main",
      runnerImage: "node:22-bookworm",
      timeoutMinutes: 30,
      environmentAllowlist: ["NPM_TOKEN", "NPM_TOKEN", "GITHUB_TOKEN"],
      apps: [
        {
          name: "Web",
          workingDirectory: "apps/web",
          testCommand: "npm test",
          coverageFormat: "lcov",
          coveragePath: "apps/web/coverage/lcov.info"
        },
        {
          name: "web",
          workingDirectory: "apps/other",
          testCommand: "npm test",
          coverageFormat: "lcov",
          coveragePath: "apps/other/coverage/lcov.info"
        }
      ]
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "App names must be unique within a repository",
          "Environment variable names must be unique",
          "GITHUB_TOKEN is reserved for cloning and cannot be passed to runners"
        ])
      );
    }
  });

  it("allows an empty app list only when auto-detection is enabled", () => {
    const base = {
      name: "Platform",
      githubUrl: "https://github.com/example/platform",
      defaultRef: "main",
      runnerImage: "node:22-bookworm",
      timeoutMinutes: 30,
      environmentAllowlist: [],
      apps: []
    };
    expect(repositoryInputSchema.safeParse(base).success).toBe(false);
    const detected = repositoryInputSchema.safeParse({ ...base, autoDetect: true });
    expect(detected.success).toBe(true);
    if (detected.success) expect(detected.data.apps).toEqual([]);
  });

  it("defaults and bounds the auto-detected test worker limit", () => {
    const base = {
      name: "Platform",
      githubUrl: "https://github.com/example/platform",
      defaultRef: "main",
      runnerImage: "node:22-bookworm",
      timeoutMinutes: 30,
      environmentAllowlist: [],
      autoDetect: true,
      apps: []
    };
    const defaulted = repositoryInputSchema.safeParse(base);
    expect(defaulted.success).toBe(true);
    if (defaulted.success) expect(defaulted.data.testWorkerLimit).toBe(2);
    expect(repositoryInputSchema.safeParse({ ...base, testWorkerLimit: 0 }).success).toBe(false);
    expect(repositoryInputSchema.safeParse({ ...base, testWorkerLimit: 17 }).success).toBe(false);
  });

  it("validates optional per-run app selections", () => {
    expect(runRequestSchema.safeParse({ ref: "main", apps: ["Web", "API"] }).success).toBe(true);
    expect(runRequestSchema.safeParse({ apps: [] }).success).toBe(false);
    expect(runRequestSchema.safeParse({ apps: ["Web", "web"] }).success).toBe(false);
  });
});
