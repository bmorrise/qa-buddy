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
    localPath: z
      .string()
      .trim()
      .refine(
        (value) => isSafeRelativePath(value, true),
        "Local checkout path must be relative and stay inside the mounted source directory"
      )
      .optional()
      .or(z.literal("").transform(() => undefined)),
    additionalWorkspaces: z
      .array(
        z
          .string()
          .trim()
          .refine(
            (value) => isSafeRelativePath(value),
            "Workspace directory must be a relative path inside the repository"
          )
      )
      .max(50)
      .default([]),
    excludedWorkspaces: z
      .array(
        z
          .string()
          .trim()
          .refine(
            (value) => isSafeRelativePath(value),
            "Workspace directory must be a relative path inside the repository"
          )
      )
      .max(50)
      .default([]),
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
    coverageGoal: z.number().min(1, "Coverage goal must be between 1 and 100").max(100, "Coverage goal must be between 1 and 100").nullable().default(null),
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

    if (new Set(value.additionalWorkspaces).size !== value.additionalWorkspaces.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additionalWorkspaces"],
        message: "Additional workspaces must be unique"
      });
    }

    if (value.additionalWorkspaces.length > 0 && !value.autoDetect) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additionalWorkspaces"],
        message: "Additional workspaces apply to auto-detection; enable it or configure these apps manually"
      });
    }

    if (new Set(value.excludedWorkspaces).size !== value.excludedWorkspaces.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excludedWorkspaces"],
        message: "Excluded workspaces must be unique"
      });
    }

    if (value.excludedWorkspaces.length > 0 && !value.autoDetect) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excludedWorkspaces"],
        message: "Excluded workspaces apply to auto-detection; remove the app from the configured list instead"
      });
    }

    const excluded = new Set(value.excludedWorkspaces);
    const conflicting = value.additionalWorkspaces.filter((workspace) => excluded.has(workspace));
    if (conflicting.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excludedWorkspaces"],
        message: `Workspaces cannot be both additional and excluded: ${conflicting.join(", ")}`
      });
    }

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
  useLocalWorkingTree: z.boolean().default(false),
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

export const coverageFileQuerySchema = z.object({
  app: z.string().trim().min(1).max(100).optional(),
  metric: z.enum(["lines", "statements", "functions", "branches"]).optional(),
  maxPercent: z.coerce.number().min(0).max(100).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const appGroupName = z.string().trim().min(1, "Group name is required").max(60);
const appGroupAppNames = z
  .array(z.string().trim().min(1).max(200))
  .min(1, "Select at least one app before saving a group")
  .max(200)
  .refine(
    (names) => new Set(names.map((name) => name.toLocaleLowerCase())).size === names.length,
    "App names in a group must be unique"
  );

export const appGroupInputSchema = z.object({
  name: appGroupName,
  appNames: appGroupAppNames
});

/** The repository's complete group list in its new display order. */
export const appGroupOrderSchema = z.object({
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Group ids must be unique")
});

/** Rename a group, replace its apps, or both. */
export const appGroupPatchSchema = z
  .object({
    name: appGroupName.optional(),
    appNames: appGroupAppNames.optional()
  })
  .refine(
    (value) => value.name !== undefined || value.appNames !== undefined,
    "Provide a new name, a new app selection, or both"
  );
