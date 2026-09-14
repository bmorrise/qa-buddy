import { describe, expect, it } from "vitest";
import { githubAuthenticationMessage, githubFetchFailureMessage } from "./git.js";

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
