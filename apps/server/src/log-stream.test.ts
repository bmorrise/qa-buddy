import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initialLogOffset, readLogChunk } from "./log-stream.js";

describe("run log streaming", () => {
  it("starts large replays at a bounded tail and reads incremental chunks", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-log-stream-"));
    const file = path.join(directory, "run.log");
    try {
      writeFileSync(file, "0123456789", "utf8");
      expect(initialLogOffset(file, 4)).toBe(6);
      expect(readLogChunk(file, 6, 2)).toEqual({ chunk: "67", nextOffset: 8, size: 10 });
      expect(readLogChunk(file, 8, 20)).toEqual({ chunk: "89", nextOffset: 10, size: 10 });
      expect(readLogChunk(file, 10, 20)).toEqual({ chunk: "", nextOffset: 10, size: 10 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
