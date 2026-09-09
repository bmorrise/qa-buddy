import path from "node:path";
import { z } from "zod";

const githubUrlPattern = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const runnerImagePattern = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export function normalizeGithubUrl(value: string): string {
  const trimmed = value.trim();
  const match = githubUrlPattern.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    throw new Error("Use a GitHub HTTPS URL such as https://github.com/owner/repository");
  }

  const owner = match[1];
  const repository = match[2].replace(/\.git$/i, "");
  if (!owner || !repository) {
    throw new Error("GitHub URL must include an owner and repository");
  }

  return `https://github.com/${owner}/${repository}.git`;
}

export function isSafeRelativePath(value: string, allowDot = false): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    return false;
  }

  const normalized = path.posix.normalize(value);
  if (normalized === ".") {
    return allowDot && value === ".";
  }

  return normalized === value && !normalized.startsWith("../") && normalized !== "..";
}

export function isSafeGitRef(value: string): boolean {
  return Boolean(
    value &&
      value.length <= 200 &&
      !value.startsWith("-") &&
      !/[\s~^:?*[\]\\]/.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      !value.endsWith("/")
  );
}

const appInputSchema = z.object({
  name: z.string().trim().min(1, "App name is required").max(100),
  workingDirectory: z
    .string()
    .trim()
    .refine((value) => isSafeRelativePath(value, true), "Working directory must stay inside the repository"),
  testCommand: z.string().trim().min(1, "Test command is required").max(4_000),
  coverageFormat: z.enum(["istanbul-summary-json", "lcov"]),
  coveragePath: z
    .string()
    .trim()
    .refine((value) => isSafeRelativePath(value), "Coverage path must stay inside the repository")
});

export const repositoryInputSchema = z
  .object({
    name: z.string().trim().min(1, "Repository name is required").max(100),
    githubUrl: z
      .string()
      .trim()
      .transform((value, context) => {
        try {
          return normalizeGithubUrl(value);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : "Invalid GitHub URL"
          });
          return z.NEVER;
        }
      }),
    defaultRef: z.string().trim().refine(isSafeGitRef, "Enter a valid branch, tag, or commit SHA"),
    runnerImage: z
      .string()
      .trim()
      .min(1, "Runner image is required")
      .max(255)
      .regex(runnerImagePattern, "Runner image contains unsupported characters"),
    setupCommand: z.string().trim().max(4_000).optional(),
    buildCommand: z.string().trim().max(4_000).optional(),
    testWorkerLimit: z.coerce.number().int().min(1).max(16).default(2),
    timeoutMinutes: z.coerce.number().int().min(1).max(120).default(30),
    environmentAllowlist: z
      .array(z.string().trim().regex(environmentNamePattern, "Invalid environment variable name"))
      .default([]),
    autoDetect: z.boolean().default(false),
    apps: z.array(appInputSchema).max(50).default([])
  })
  .superRefine((value, context) => {
    if (!value.autoDetect && value.apps.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apps"],
        message: "Configure at least one app or enable pnpm/Turborepo auto-detection"
      });
    }

    const names = new Set<string>();
    value.apps.forEach((app, index) => {
      const key = app.name.toLocaleLowerCase();
      if (names.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apps", index, "name"],
          message: "App names must be unique within a repository"
        });
      }
      names.add(key);
    });

    if (new Set(value.environmentAllowlist).size !== value.environmentAllowlist.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environmentAllowlist"],
        message: "Environment variable names must be unique"
      });
    }

    if (value.environmentAllowlist.includes("GITHUB_TOKEN")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environmentAllowlist"],
        message: "GITHUB_TOKEN is reserved for cloning and cannot be passed to runners"
      });
    }
  });

export const runRequestSchema = z.object({
  ref: z.string().trim().refine(isSafeGitRef, "Enter a valid branch, tag, or commit SHA").optional(),
  apps: z
    .array(z.string().trim().min(1, "App name is required").max(100))
    .min(1, "Select at least one app")
    .max(50)
    .optional()
}).superRefine((value, context) => {
  if (value.apps && new Set(value.apps.map((name) => name.toLocaleLowerCase())).size !== value.apps.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apps"],
      message: "Selected app names must be unique"
    });
  }
});

export type RepositoryInputValidation = z.infer<typeof repositoryInputSchema>;
