import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import Docker from "dockerode";
import type { RunLogger } from "./logger.js";
import { formatMinutes } from "./timeouts.js";

/** The whole run is out of time; the runner container has been killed. */
export class RunnerTimeoutError extends Error {}

/** One command was stopped for running too long; the runner is still usable. */
export class CommandTimeoutError extends Error {}

export interface RunnerCommandResult {
  exitCode: number;
}

export interface CommandLimits {
  /** Time left before the run's overall deadline; exceeding it ends the run. */
  runRemainingMs: number;
  /** Stop just this command after it prints nothing for this long. */
  idleMs?: number;
  /** Stop just this command after it has run this long. */
  commandMs?: number;
}

/**
 * Records the shell's PID, then replaces itself with the command. Docker starts
 * every exec in its own process group led by that PID, so killing the group
 * stops the command and any workers it forked without touching the container.
 */
const PROCESS_GROUP_WRAPPER = 'echo $$ > "$2"; exec /bin/sh -lc "$1"';

const KILL_GRACE_MS = 30_000;

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
      /** How long a killed command may take to release its output stream. */
      killGraceMs?: number;
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

  async exec(command: string, workingDirectory: string, limits: CommandLimits): Promise<RunnerCommandResult> {
    if (!this.container) throw new Error("Runner is not started");
    if (limits.runRemainingMs <= 0) throw new RunnerTimeoutError("Runner command timed out");
    this.options.logger.line(`$ (${workingDirectory}) ${command}`);
    const pidFile = `/tmp/qa-buddy-${randomUUID()}.pid`;
    const commandExec = await this.container.exec({
      Cmd: ["/bin/sh", "-c", PROCESS_GROUP_WRAPPER, "qa-buddy", command, pidFile],
      WorkingDir: workingDirectory,
      AttachStdout: true,
      AttachStderr: true
    });
    const stream = await commandExec.start({ hijack: true, stdin: false });

    const timers: NodeJS.Timeout[] = [];
    let idleTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let timeout: (error: Error) => void = () => undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = reject;
    });
    const resetIdleTimer = (): void => {
      // Output can trail the end of the stream; it must not start a new timer.
      if (!limits.idleMs || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          timeout(new CommandTimeoutError(`Command produced no output for ${formatMinutes(limits.idleMs!)}`)),
        limits.idleMs
      );
    };

    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        resetIdleTimer();
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

    timers.push(
      setTimeout(() => timeout(new RunnerTimeoutError("Runner command timed out")), limits.runRemainingMs)
    );
    if (limits.commandMs) {
      timers.push(
        setTimeout(
          () =>
            timeout(
              new CommandTimeoutError(`Command exceeded its ${formatMinutes(limits.commandMs!)} time limit`)
            ),
          limits.commandMs
        )
      );
    }
    resetIdleTimer();

    try {
      await Promise.race([completion, timedOut]);
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        await this.stopCommand(pidFile, completion);
      } else {
        await this.forceStop();
      }
      throw error;
    } finally {
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
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

  /** Kills the container so an in-flight exec stops streaming and settles. */
  async stop(): Promise<void> {
    await this.forceStop();
  }

  /**
   * Kills one command's process group so later commands can reuse the runner.
   * If the command will not let go, the whole runner is killed instead and the
   * run cannot continue.
   */
  private async stopCommand(pidFile: string, completion: Promise<void>): Promise<void> {
    try {
      const killExec = await this.container!.exec({
        Cmd: ["/bin/sh", "-c", 'kill -KILL -"$(cat "$1")"', "qa-buddy", pidFile],
        AttachStdout: true,
        AttachStderr: true
      });
      // Attached and drained rather than detached: Docker holds a detached
      // exec's connection open until its response is read.
      const killStream = await killExec.start({ hijack: true, stdin: false });
      const killed = new Promise<void>((resolve) => {
        killStream.on("end", resolve);
        killStream.on("close", resolve);
        killStream.on("error", () => resolve());
        killStream.resume();
      });
      const graceMs = this.options.killGraceMs ?? KILL_GRACE_MS;
      await this.raceTimeout(killed, graceMs, "Kill command did not finish");
      await this.raceTimeout(completion.catch(() => undefined), graceMs, "Command did not stop");
    } catch {
      await this.forceStop();
      throw new RunnerTimeoutError("A timed-out command could not be stopped, so the runner was shut down");
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
