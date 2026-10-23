import { describe, expect, it } from "vitest";
import {
  githubAuthenticationMessage,
  githubFetchFailureMessage,
  githubRegistryAuthenticationMessage,
  isAuthenticationFailure,
  isRetryableFetchFailure,
  probeGitHubToken
} from "./git.js";

describe("GitHub clone authentication diagnostics", () => {
  it("shows only the first ten token characters with a masked suffix", () => {
    const token = "ghp_1234567_private_remainder";
    const message = githubAuthenticationMessage(token);
    expect(message).toBe("GitHub authentication: GITHUB_TOKEN is configured (ghp_123456********)");
    expect(message).not.toContain(token);
    expect(message).not.toContain(token.slice(10));
  });

  it.each(["short", "1234567890"])("fully redacts short tokens (%s)", (token) => {
    expect(githubAuthenticationMessage(token)).toBe(
      "GitHub authentication: GITHUB_TOKEN is configured ([REDACTED])"
    );
  });

  it("reports missing tokens without a preview", () => {
    expect(githubAuthenticationMessage()).toContain("not configured");
    expect(githubAuthenticationMessage("")).toContain("not configured");
  });

  it("explains how to configure private repository access when no token is present", () => {
    expect(githubFetchFailureMessage(false)).toContain("set GITHUB_TOKEN in .env");
  });

  it("does not expose a configured token and points to permissions or ref failures", () => {
    const message = githubFetchFailureMessage(true);
    expect(message).toContain("GITHUB_TOKEN can read this repository");
    expect(message).toContain("requested ref exists");
  });
});

describe("GitHub package registry authentication diagnostics", () => {
  it("shows only the first ten registry token characters", () => {
    const token = "ghp_registry_private_remainder";
    const message = githubRegistryAuthenticationMessage(token);
    expect(message).toBe("Package registry authentication: GITHUB_IDP_REGISTRY is configured (ghp_regist********)");
    expect(message).not.toContain(token);
    expect(message).not.toContain(token.slice(10));
  });

  it.each(["short", "1234567890"])("fully redacts short registry tokens (%s)", (token) => {
    expect(githubRegistryAuthenticationMessage(token)).toBe(
      "Package registry authentication: GITHUB_IDP_REGISTRY is configured ([REDACTED])"
    );
  });

  it("reports a missing registry token", () => {
    expect(githubRegistryAuthenticationMessage()).toContain("GITHUB_IDP_REGISTRY is not configured");
    expect(githubRegistryAuthenticationMessage("")).toContain("GITHUB_IDP_REGISTRY is not configured");
  });
});

describe("GitHub fetch failure classification", () => {
  const invalidToken =
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/idplans/idplans-platform.git/'\n";

  it("treats GitHub's intermittent invalid token response as a retryable authentication failure", () => {
    expect(isAuthenticationFailure(invalidToken)).toBe(true);
    expect(isRetryableFetchFailure(invalidToken)).toBe(true);
  });

  it("retries network errors without probing the token", () => {
    const stderr = "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com\n";
    expect(isAuthenticationFailure(stderr)).toBe(false);
    expect(isRetryableFetchFailure(stderr)).toBe(true);
  });

  it.each([
    "fatal: couldn't find remote ref missing-branch\n",
    "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found\n"
  ])("does not retry permanent failures (%s)", (stderr) => {
    expect(isRetryableFetchFailure(stderr)).toBe(false);
  });
});

describe("GitHub API token probe", () => {
  it("skips URLs it cannot parse without making a request", async () => {
    await expect(probeGitHubToken("https://example.com/repo.git", "token")).resolves.toContain("skipped");
  });
});
