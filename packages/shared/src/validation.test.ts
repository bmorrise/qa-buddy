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

  it("accepts an optional coverage goal between 1 and 100", () => {
    const base = {
      name: "Platform",
      githubUrl: "https://github.com/example/platform",
      defaultRef: "main",
      runnerImage: "node:22-bookworm",
      autoDetect: true
    };
    const unset = repositoryInputSchema.safeParse(base);
    expect(unset.success && unset.data.coverageGoal).toBeNull();
    expect(repositoryInputSchema.safeParse({ ...base, coverageGoal: 70 }).success).toBe(true);
    expect(repositoryInputSchema.safeParse({ ...base, coverageGoal: 0 }).success).toBe(false);
    expect(repositoryInputSchema.safeParse({ ...base, coverageGoal: 101 }).success).toBe(false);
  });

  it("validates optional per-run app selections", () => {
    expect(runRequestSchema.safeParse({ ref: "main", apps: ["Web", "API"] }).success).toBe(true);
    expect(runRequestSchema.safeParse({ apps: [] }).success).toBe(false);
    expect(runRequestSchema.safeParse({ apps: ["Web", "web"] }).success).toBe(false);
  });
});

describe("local checkout path", () => {
  const base = {
    name: "Example",
    githubUrl: "https://github.com/example/repository",
    defaultRef: "main",
    runnerImage: "node:22-bookworm",
    autoDetect: true,
    apps: []
  };

  it("accepts a relative path inside the mounted source directory", () => {
    const parsed = repositoryInputSchema.parse({ ...base, localPath: "group/my-repo" });
    expect(parsed.localPath).toBe("group/my-repo");
  });

  it("treats an empty value as unset", () => {
    expect(repositoryInputSchema.parse({ ...base, localPath: "" }).localPath).toBeUndefined();
    expect(repositoryInputSchema.parse(base).localPath).toBeUndefined();
  });

  it.each(["../escape", "nested/../../escape", "/absolute"])("rejects %s", (localPath) => {
    expect(repositoryInputSchema.safeParse({ ...base, localPath }).success).toBe(false);
  });

  it("defaults local working tree runs to off", () => {
    expect(runRequestSchema.parse({}).useLocalWorkingTree).toBe(false);
    expect(runRequestSchema.parse({ useLocalWorkingTree: true }).useLocalWorkingTree).toBe(true);
  });
});

describe("additional workspaces", () => {
  const base = {
    name: "Example",
    githubUrl: "https://github.com/example/repository",
    defaultRef: "main",
    runnerImage: "node:22-bookworm",
    autoDetect: true,
    apps: []
  };

  it("accepts relative workspace directories", () => {
    const parsed = repositoryInputSchema.parse({
      ...base,
      additionalWorkspaces: ["libs/scout-ui", "libs/infuse-ui"]
    });
    expect(parsed.additionalWorkspaces).toEqual(["libs/scout-ui", "libs/infuse-ui"]);
  });

  it("defaults to none", () => {
    expect(repositoryInputSchema.parse(base).additionalWorkspaces).toEqual([]);
  });

  it.each(["../escape", "/libs/scout-ui", "libs/../../escape"])("rejects %s", (workspace) => {
    expect(
      repositoryInputSchema.safeParse({ ...base, additionalWorkspaces: [workspace] }).success
    ).toBe(false);
  });

  it("rejects duplicates", () => {
    const result = repositoryInputSchema.safeParse({
      ...base,
      additionalWorkspaces: ["libs/scout-ui", "libs/scout-ui"]
    });
    expect(result.success).toBe(false);
  });

  it("rejects additional workspaces when auto-detection is off", () => {
    const result = repositoryInputSchema.safeParse({
      ...base,
      autoDetect: false,
      apps: [
        {
          name: "Web",
          workingDirectory: ".",
          testCommand: "pnpm test",
          coverageFormat: "istanbul-summary-json",
          coveragePath: "coverage/coverage-summary.json"
        }
      ],
      additionalWorkspaces: ["libs/scout-ui"]
    });
    expect(result.success).toBe(false);
  });
});

describe("excluded workspaces", () => {
  const base = {
    name: "Platform",
    githubUrl: "https://github.com/example/repository",
    defaultRef: "main",
    runnerImage: "node:22-bookworm",
    autoDetect: true,
    apps: []
  };

  it("accepts relative workspace directories and defaults to none", () => {
    expect(repositoryInputSchema.parse(base).excludedWorkspaces).toEqual([]);
    expect(
      repositoryInputSchema.parse({ ...base, excludedWorkspaces: ["apps/user-crm-sync"] }).excludedWorkspaces
    ).toEqual(["apps/user-crm-sync"]);
  });

  it.each(["../escape", "/apps/user-crm-sync", "apps/../../escape"])("rejects %s", (workspace) => {
    expect(repositoryInputSchema.safeParse({ ...base, excludedWorkspaces: [workspace] }).success).toBe(false);
  });

  it("rejects duplicates", () => {
    expect(
      repositoryInputSchema.safeParse({ ...base, excludedWorkspaces: ["apps/user-crm-sync", "apps/user-crm-sync"] })
        .success
    ).toBe(false);
  });

  it("rejects excluded workspaces when auto-detection is off", () => {
    const result = repositoryInputSchema.safeParse({
      ...base,
      autoDetect: false,
      apps: [
        {
          name: "Web",
          workingDirectory: ".",
          testCommand: "pnpm test",
          coverageFormat: "istanbul-summary-json",
          coveragePath: "coverage/coverage-summary.json"
        }
      ],
      excludedWorkspaces: ["apps/user-crm-sync"]
    });
    expect(result.success).toBe(false);
  });

  it("rejects a workspace that is both additional and excluded", () => {
    const result = repositoryInputSchema.safeParse({
      ...base,
      additionalWorkspaces: ["libs/scout-ui"],
      excludedWorkspaces: ["libs/scout-ui"]
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("both additional and excluded: libs/scout-ui");
  });
});
