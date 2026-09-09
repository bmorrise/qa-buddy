import { spawn } from "node:child_process";
import type { RunLogger } from "./logger.js";

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message);
  }
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
}

export async function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger: RunLogger;
  timeoutMs: number;
  display?: string;
}): Promise<ProcessResult> {
  const display = options.display ?? [options.command, ...options.args].join(" ");
  options.logger.line(`$ ${display}`);

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new ProcessError(`Command timed out: ${display}`, null));
    }, Math.max(1, options.timeoutMs));

    child.stdout.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      stdout += value;
      options.logger.write(value);
    });
    child.stderr.on("data", (chunk: Buffer) => options.logger.write(chunk.toString("utf8")));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ exitCode: 0, stdout });
      else reject(new ProcessError(`Command exited with code ${code ?? "unknown"}: ${display}`, code));
    });
  });
}
