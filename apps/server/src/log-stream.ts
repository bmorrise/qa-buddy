import { closeSync, openSync, readSync, statSync } from "node:fs";

export const INITIAL_LOG_TAIL_BYTES = 256 * 1024;
export const LOG_EVENT_BYTES = 64 * 1024;

export function initialLogOffset(filePath: string, tailBytes = INITIAL_LOG_TAIL_BYTES): number {
  return Math.max(0, statSync(filePath).size - tailBytes);
}

export function readLogChunk(
  filePath: string,
  offset: number,
  maxBytes = LOG_EVENT_BYTES
): { chunk: string; nextOffset: number; size: number } {
  const size = statSync(filePath).size;
  if (offset >= size) return { chunk: "", nextOffset: size, size };

  const length = Math.min(maxBytes, size - offset);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = openSync(filePath, "r");
  try {
    const bytesRead = readSync(descriptor, buffer, 0, length, offset);
    return {
      chunk: buffer.subarray(0, bytesRead).toString("utf8"),
      nextOffset: offset + bytesRead,
      size
    };
  } finally {
    closeSync(descriptor);
  }
}
