import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";

export interface WorkspacePackage {
  /** Repository-relative POSIX directory, for example `apps/idinspect`. */
  directory: string;
  /** package.json name, when it has one. */
  name: string | null;
  manifest: Record<string, unknown>;
}

function safePattern(pattern: string): boolean {
  const candidate = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return Boolean(
    candidate &&
      !candidate.startsWith("/") &&
      !candidate.includes("\\") &&
      !candidate.includes("\0") &&
      !candidate.split("/").includes("..")
  );
}

/** Every pnpm workspace package in the checkout, sorted by directory. */
export async function listWorkspacePackages(repositoryDirectory: string): Promise<WorkspacePackage[]> {
  const workspacePath = path.join(repositoryDirectory, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) {
    throw new Error("Slices require pnpm-workspace.yaml at the repository root");
  }
  const document = parseYaml(readFileSync(workspacePath, "utf8")) as { packages?: unknown };
  const patterns = Array.isArray(document?.packages)
    ? document.packages.filter((value): value is string => typeof value === "string" && safePattern(value))
    : [];
  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml does not contain any safe workspace patterns");
  }

  const directories = (
    await fg(patterns, {
      cwd: repositoryDirectory,
      onlyDirectories: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**"]
    })
  )
    .map((directory) => directory.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((directory) => directory && !directory.startsWith("../"))
    .sort((left, right) => left.localeCompare(right));

  return directories.flatMap((directory) => {
    const manifestPath = path.join(repositoryDirectory, directory, "package.json");
    if (!existsSync(manifestPath)) return [];
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : null;
      return [{ directory, name, manifest }];
    } catch {
      return [];
    }
  });
}
