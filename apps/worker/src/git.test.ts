import { describe, expect, it } from "vitest";
import { githubFetchFailureMessage } from "./git.js";

describe("GitHub clone authentication diagnostics", () => {
  it("explains how to configure private repository access when no token is present", () => {
    expect(githubFetchFailureMessage(false)).toContain("set GITHUB_TOKEN in .env");
  });

  it("does not expose a configured token and points to permissions or ref failures", () => {
    const message = githubFetchFailureMessage(true);
    expect(message).toContain("GITHUB_TOKEN can read this repository");
    expect(message).toContain("requested ref exists");
  });
});
