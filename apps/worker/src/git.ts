import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { RunLogger } from "./logger.js";
import { ProcessError, runProcess } from "./process.js";

function tokenPreview(token: string): string {
  return token.length > 10 ? `${token.slice(0, 10)}********` : "[REDACTED]";
}

export function githubAuthenticationMessage(token?: string): string {
  if (!token) {
    return "GitHub authentication: not configured; clone access is limited to public repositories";
  }
  return `GitHub authentication: GITHUB_TOKEN is configured (${tokenPreview(token)})`;
}

export function githubRegistryAuthenticationMessage(token?: string): string {
  return token
    ? `Package registry authentication: GITHUB_IDP_REGISTRY is configured (${tokenPreview(token)})`
    : "Package registry authentication: GITHUB_IDP_REGISTRY is not configured";
}

export function githubFetchFailureMessage(tokenConfigured: boolean): string {
  return tokenConfigured
    ? "GitHub fetch failed. Verify that GITHUB_TOKEN can read this repository and that the requested ref exists"
    : "GitHub fetch failed. This repository may be private; set GITHUB_TOKEN in .env and recreate the worker";
}

/**
 * GitHub occasionally rejects a valid token on Git-over-HTTPS with "Invalid
 * username or token", and the same request succeeds moments later, so fetches
 * are retried with these delays.
 */
const fetchRetryDelaysMs = [2_000, 5_000];

export function isAuthenticationFailure(stderr: string): boolean {
  return /Invalid username or (token|password)|Authentication failed/i.test(stderr);
}

export function isRetryableFetchFailure(stderr: string): boolean {
  return !/couldn't find remote ref|Repository not found/i.test(stderr);
}

/**
 * Asks the REST API whether the same token can read the repository, so an
 * authentication failure in the log shows whether GitHub rejected the token
 * everywhere or only on the Git endpoint. It never throws and never prints the token.
 */
export async function probeGitHubToken(githubUrl: string, token: string): Promise<string> {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(githubUrl);
  if (!match) return "GitHub API check skipped: could not parse owner and repository from the URL";
  const [, owner, repository] = match;
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repository}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "qa-buddy"
      },
      signal: AbortSignal.timeout(5_000)
    });
    const header = (name: string) => response.headers.get(name) ?? "unknown";
    return (
      `GitHub API check: HTTP ${response.status} for ${owner}/${repository}` +
      ` (request id ${header("x-github-request-id")}, rate limit remaining ${header("x-ratelimit-remaining")},` +
      ` token expires ${header("github-authentication-token-expiration")})`
    );
  } catch (error) {
    return `GitHub API check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
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
  for (let attempt = 0; ; attempt += 1) {
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
      if (attempt > 0) options.logger.line(`GitHub fetch succeeded on retry ${attempt}`);
      break;
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      if (options.githubToken && isAuthenticationFailure(error.stderr)) {
        options.logger.line(await probeGitHubToken(options.githubUrl, options.githubToken));
      }
      const delayMs = fetchRetryDelaysMs[attempt];
      // A timeout (null exit code) has spent the run budget, and a missing ref
      // or repository will not appear on retry.
      if (
        delayMs === undefined ||
        error.exitCode === null ||
        !isRetryableFetchFailure(error.stderr) ||
        delayMs >= options.timeoutMs()
      ) {
        throw new ProcessError(githubFetchFailureMessage(Boolean(options.githubToken)), error.exitCode, error.stderr);
      }
      options.logger.line(
        `GitHub fetch failed (attempt ${attempt + 1} of ${fetchRetryDelaysMs.length + 1}); retrying in ${delayMs / 1000}s`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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

/**
 * Basenames that look like credentials. `sensitive` files are skipped when they
 * are untracked, because a GitHub run would not contain them either; `suspicious`
 * ones are only ever reported.
 */
const secretFilePatterns: Array<{ pattern: RegExp; severity: "sensitive" | "suspicious"; label: string }> = [
  { pattern: /^\.env$/i, severity: "sensitive", label: "environment file" },
  { pattern: /^\.env\.(?!example$|sample$|template$|defaults$|dist$)[^.]*$/i, severity: "sensitive", label: "environment file" },
  { pattern: /^\.netrc$/i, severity: "sensitive", label: "netrc credentials" },
  { pattern: /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i, severity: "sensitive", label: "private SSH key" },
  { pattern: /\.(pem|p12|pfx|keystore)$/i, severity: "suspicious", label: "possible certificate or key material" },
  { pattern: /\.key$/i, severity: "suspicious", label: "possible key material" }
];

function classifySecretFile(
  basename: string
): { severity: "sensitive" | "suspicious"; label: string } | null {
  for (const entry of secretFilePatterns) {
    if (entry.pattern.test(basename)) return { severity: entry.severity, label: entry.label };
  }
  return null;
}

/**
 * Reports committed files that look like credentials. Nothing is deleted: a
 * local run must contain exactly what a GitHub run would, plus uncommitted
 * changes. Removing a tracked file here would make local runs diverge from
 * main, silently breaking suites that rely on a committed fixture such as
 * `.env.test`.
 */
export function auditCheckoutSecrets(root: string, logger: RunLogger): number {
  let warnings = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(absolute);
        continue;
      }
      const match = classifySecretFile(entry.name);
      if (!match) continue;
      warnings += 1;
      logger.line(
        `Warning: ${path.relative(root, absolute)} looks like ${match.label} and is committed to this repository, so the runner receives it here exactly as it would for a GitHub run`
      );
    }
  };
  walk(root);
  return warnings;
}

export function resolveLocalRepositoryPath(localSourceDirectory: string, localPath: string): string {
  const root = path.resolve(localSourceDirectory);
  const resolved = path.resolve(root, localPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Local checkout path escaped the mounted source directory");
  }
  return resolved;
}

/**
 * Materializes the host checkout into the run workspace without writing to it.
 *
 * `git archive HEAD` provides the committed tree, then modified and untracked
 * files are overlaid and deleted files removed, so uncommitted work is included
 * while gitignored files (`.env`, `node_modules`, build output) never are.
 */
export async function archiveLocalWorkingTree(options: {
  localSourceDirectory: string;
  localPath: string;
  runDirectory: string;
  logger: RunLogger;
  timeoutMs: () => number;
}): Promise<{ repositoryDirectory: string; resolvedSha: string; dirty: boolean }> {
  const sourceDirectory = resolveLocalRepositoryPath(options.localSourceDirectory, options.localPath);
  if (!existsSync(path.join(sourceDirectory, ".git"))) {
    throw new Error(
      `No Git checkout found at ${options.localPath} inside the mounted source directory. Check QA_BUDDY_LOCAL_SOURCE_ROOT and the repository's local checkout path.`
    );
  }

  mkdirSync(options.runDirectory, { recursive: true });
  const repositoryDirectory = path.join(options.runDirectory, "repo");
  mkdirSync(repositoryDirectory, { recursive: true });
  const archivePath = path.join(options.runDirectory, "source.tar");

  options.logger.line(`Archiving local working tree from ${options.localPath}`);

  const revision = await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: sourceDirectory,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  const resolvedSha = revision.stdout.trim();

  // Writes the tar to the run workspace; the source mount stays read-only.
  await runProcess({
    command: "git",
    args: ["archive", "--format=tar", "-o", archivePath, "HEAD"],
    cwd: sourceDirectory,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  await runProcess({
    command: "tar",
    args: ["-x", "-f", archivePath, "-C", repositoryDirectory],
    cwd: options.runDirectory,
    logger: options.logger,
    timeoutMs: options.timeoutMs()
  });
  rmSync(archivePath, { force: true });

  const deleted = await listFiles(sourceDirectory, ["ls-files", "-z", "--deleted"], options);
  const deletedSet = new Set(deleted);
  // --modified covers tracked edits, --others plus --exclude-standard covers new
  // files while still honouring .gitignore.
  const changed = await listFiles(
    sourceDirectory,
    ["ls-files", "-z", "--modified", "--others", "--exclude-standard"],
    options
  );

  let copied = 0;
  let skipped = 0;
  for (const relative of changed) {
    if (deletedSet.has(relative)) continue;
    const destination = safeJoin(repositoryDirectory, relative);
    if (!destination) {
      options.logger.line(`Skipped a working-tree path that escaped the checkout: ${relative}`);
      continue;
    }
    // Untracked and not ignored: a GitHub run would not have this file either,
    // so skipping it keeps the two sources equivalent.
    const match = classifySecretFile(path.basename(relative));
    if (match?.severity === "sensitive") {
      skipped += 1;
      options.logger.line(`Skipped uncommitted ${match.label}: ${relative}`);
      continue;
    }
    const source = path.join(sourceDirectory, relative);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied += 1;
  }

  let removed = 0;
  for (const relative of deletedSet) {
    const destination = safeJoin(repositoryDirectory, relative);
    if (!destination || !existsSync(destination)) continue;
    rmSync(destination, { force: true });
    removed += 1;
  }

  const dirty = copied > 0 || removed > 0;
  options.logger.line(
    dirty
      ? `Applied uncommitted changes: ${copied} added or modified, ${removed} deleted${skipped ? `, ${skipped} skipped as sensitive` : ""}`
      : "Local working tree is clean; the checkout matches HEAD"
  );

  auditCheckoutSecrets(repositoryDirectory, options.logger);

  return { repositoryDirectory, resolvedSha, dirty };
}

function safeJoin(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}

async function listFiles(
  cwd: string,
  args: string[],
  options: { logger: RunLogger; timeoutMs: () => number }
): Promise<string[]> {
  // NUL-separated output must not reach the run log, which is streamed as text.
  const result = await runProcess({
    command: "git",
    args,
    cwd,
    logger: options.logger,
    timeoutMs: options.timeoutMs(),
    quiet: true
  });
  return result.stdout.split("\0").filter((value) => value.length > 0);
}
