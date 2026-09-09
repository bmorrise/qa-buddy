import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunLogger } from "./logger.js";

describe("RunLogger", () => {
  it("redacts clone and runner secrets from persisted logs", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-log-"));
    try {
      const logger = new RunLogger(directory, "run-1", ["github-secret", "npm-secret"]);
      logger.line("using github-secret and npm-secret");
      const contents = readFileSync(logger.filePath, "utf8");
      expect(contents).not.toContain("github-secret");
      expect(contents).not.toContain("npm-secret");
      expect(contents.match(/\[REDACTED\]/g)).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
