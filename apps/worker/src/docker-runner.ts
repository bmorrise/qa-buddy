import { Writable } from "node:stream";
import Docker from "dockerode";
import type { RunLogger } from "./logger.js";

export class RunnerTimeoutError extends Error {}

export interface RunnerCommandResult {
  exitCode: number;
}

export class DockerRunner {
  private container: Docker.Container | null = null;

  constructor(
    private readonly docker: Docker,
    private readonly options: {
      runId: string;
      image: string;
      workspaceVolume: string;
      workspaceContainerPath: string;
      environment: Record<string, string>;
      logger: RunLogger;
    }
  ) {}

  async start(timeoutMs: number): Promise<void> {
    await this.ensureImage(timeoutMs);
    this.options.logger.line(`Starting runner image ${this.options.image}`);
    this.container = await this.docker.createContainer({
      name: `qa-buddy-run-${this.options.runId}`,
      Image: this.options.image,
      Cmd: ["/bin/sh", "-lc", "while :; do sleep 3600; done"],
      WorkingDir: this.options.workspaceContainerPath,
      Env: Object.entries(this.options.environment).map(([key, value]) => `${key}=${value}`),
      Labels: {
        "qa-buddy.runner": "true",
        "qa-buddy.run-id": this.options.runId
      },
      HostConfig: {
        Mounts: [
          {
            Type: "volume",
            Source: this.options.workspaceVolume,
            Target: "/workspaces"
          }
        ]
      }
    });
    await this.raceTimeout(this.container.start(), timeoutMs, "Runner startup timed out");
  }

  async exec(command: string, workingDirectory: string, timeoutMs: number): Promise<RunnerCommandResult> {
    if (!this.container) throw new Error("Runner is not started");
    this.options.logger.line(`$ (${workingDirectory}) ${command}`);
    const commandExec = await this.container.exec({
      Cmd: ["/bin/sh", "-lc", command],
      WorkingDir: workingDirectory,
      AttachStdout: true,
      AttachStderr: true
    });
    const stream = await commandExec.start({ hijack: true, stdin: false });
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.options.logger.write(chunk.toString("utf8"));
        callback();
      }
    });
    this.docker.modem.demuxStream(stream, sink, sink);

    const completion = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });

    try {
      await this.raceTimeout(completion, timeoutMs, "Runner command timed out");
    } catch (error) {
      await this.forceStop();
      throw error;
    }
    const inspection = await commandExec.inspect();
    return { exitCode: inspection.ExitCode ?? 1 };
  }

  async remove(): Promise<void> {
    if (!this.container) return;
    try {
      await this.container.remove({ force: true, v: false });
    } finally {
      this.container = null;
    }
  }

  private async forceStop(): Promise<void> {
    if (!this.container) return;
    try {
      await this.container.kill();
    } catch {
      // The container may already be stopped or removed.
    }
  }

  private async ensureImage(timeoutMs: number): Promise<void> {
    try {
      await this.docker.getImage(this.options.image).inspect();
      return;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw error;
    }

    this.options.logger.line(`Pulling runner image ${this.options.image}`);
    const stream = await this.docker.pull(this.options.image);
    const pull = new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
    });
    await this.raceTimeout(pull, timeoutMs, "Runner image pull timed out");
  }

  private async raceTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (timeoutMs <= 0) throw new RunnerTimeoutError(message);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RunnerTimeoutError(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function cleanupOrphanRunners(docker: Docker): Promise<number> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ["qa-buddy.runner=true"] }
  });
  await Promise.all(
    containers.map(async (containerInfo) => {
      try {
        await docker.getContainer(containerInfo.Id).remove({ force: true, v: false });
      } catch {
        // Best effort recovery; the next run uses a unique container name.
      }
    })
  );
  return containers.length;
}
