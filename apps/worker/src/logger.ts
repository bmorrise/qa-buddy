import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export class RunLogger {
  readonly filePath: string;
  private readonly secrets: string[];

  constructor(dataDirectory: string, runId: string, secrets: Array<string | undefined>) {
    const logDirectory = path.join(dataDirectory, "logs");
    mkdirSync(logDirectory, { recursive: true });
    this.filePath = path.join(logDirectory, `${runId}.log`);
    writeFileSync(this.filePath, "", "utf8");
    this.secrets = secrets.filter((value): value is string => Boolean(value));
  }

  private redact(value: string): string {
    return this.secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
  }

  write(value: string): void {
    appendFileSync(this.filePath, this.redact(value), "utf8");
  }

  line(value: string): void {
    const timestamp = new Date().toISOString();
    this.write(`[${timestamp}] ${value}\n`);
  }
}
