import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { repositoryInputSchema, runRequestSchema, terminalRunStatuses } from "@qa-buddy/shared";
import { initialLogOffset, readLogChunk } from "./log-stream.js";

export interface ServerOptions {
  database: QaBuddyDatabase;
  dataDirectory: string;
  webDirectory?: string;
  logger?: boolean;
}

function issueMessage(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as Error & { code: unknown }).code).startsWith("SQLITE_CONSTRAINT_UNIQUE")
  );
}

function logPath(dataDirectory: string, runId: string): string {
  return path.join(dataDirectory, "logs", `${runId}.log`);
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const { database } = options;

  app.get("/api/health", async () => ({ status: "ok", service: "qa-buddy" }));

  app.get("/api/repositories", async () => ({ repositories: database.listRepositories() }));

  app.post("/api/repositories", async (request, reply) => {
    const parsed = repositoryInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: issueMessage(parsed.error) });
    }
    try {
      return reply.code(201).send({ repository: database.createRepository(parsed.data) });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return reply.code(409).send({ error: "That GitHub repository is already configured" });
      }
      throw error;
    }
  });

  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId", async (request, reply) => {
    const repository = database.getRepositoryDetail(request.params.repositoryId);
    if (!repository) return reply.code(404).send({ error: "Repository not found" });
    return { repository };
  });

  app.patch<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId",
    async (request, reply) => {
      const parsed = repositoryInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      try {
        const repository = database.updateRepository(request.params.repositoryId, parsed.data);
        if (!repository) return reply.code(404).send({ error: "Repository not found" });
        return { repository };
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return reply.code(409).send({ error: "That GitHub repository is already configured" });
        }
        throw error;
      }
    }
  );

  app.delete<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId",
    async (request, reply) => {
      const result = database.deleteRepository(request.params.repositoryId);
      if (result.active) {
        return reply.code(409).send({ error: "Wait for the active run to finish before deleting this repository" });
      }
      if (!result.deleted) return reply.code(404).send({ error: "Repository not found" });
      for (const runId of result.runIds) {
        rmSync(logPath(options.dataDirectory, runId), { force: true });
      }
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/runs",
    async (request, reply) => {
      const parsed = runRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      const repository = database.getRepositoryDetail(request.params.repositoryId);
      if (!repository) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      if (parsed.data.apps) {
        if (repository.selectableApps.length === 0) {
          return reply.code(400).send({
            error: "Run all apps once so QA Buddy can discover the selectable applications"
          });
        }
        const available = new Map(
          repository.selectableApps.map((app) => [app.name.toLocaleLowerCase(), app.name] as const)
        );
        const missing = parsed.data.apps.filter((name) => !available.has(name.toLocaleLowerCase()));
        if (missing.length > 0) {
          return reply.code(400).send({ error: `Unknown app selection: ${missing.join(", ")}` });
        }
      }
      try {
        const run = database.createRun(request.params.repositoryId, parsed.data.ref, parsed.data.apps);
        return reply.code(202).send({ run });
      } catch (error) {
        if (error instanceof Error && error.message.includes("already has")) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/runs",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      return { runs: database.listRuns(request.params.repositoryId, 20) };
    }
  );

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    const run = database.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return { run };
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/log", async (request, reply) => {
    if (!database.getRun(request.params.runId)) {
      return reply.code(404).send({ error: "Run not found" });
    }
    const file = logPath(options.dataDirectory, request.params.runId);
    if (!existsSync(file)) return reply.code(404).send({ error: "Run log is not available yet" });
    return reply
      .type("text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="qa-buddy-run-${request.params.runId}.log"`)
      .send(createReadStream(file));
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", async (request, reply) => {
    if (!database.getRun(request.params.runId)) {
      return reply.code(404).send({ error: "Run not found" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write("retry: 1000\n\n");

    const file = logPath(options.dataDirectory, request.params.runId);
    let offset = 0;
    let logInitialized = false;
    let previousRun = "";
    let terminalTicks = 0;

    const send = (event: string, data: unknown): void => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    const poll = (): void => {
      try {
        if (existsSync(file)) {
          const size = statSync(file).size;
          if (!logInitialized) {
            offset = initialLogOffset(file);
            logInitialized = true;
            if (offset > 0) {
              send("log", { chunk: `[Earlier log output omitted from live view; download the full log for all ${size.toLocaleString()} bytes.]\n` });
            }
          } else if (size < offset) {
            offset = 0;
            send("log", { chunk: "[Run log restarted.]\n" });
          }

          while (offset < size) {
            const result = readLogChunk(file, offset);
            offset = result.nextOffset;
            if (result.chunk) send("log", { chunk: result.chunk });
            if (!result.chunk) break;
          }
        }

        const run = database.getRun(request.params.runId);
        if (!run) {
          send("error", { message: "Run was deleted" });
          clearInterval(interval);
          reply.raw.end();
          return;
        }

        const serialized = JSON.stringify(run);
        if (serialized !== previousRun) {
          previousRun = serialized;
          send("run", run);
        }

        if (terminalRunStatuses.includes(run.status)) {
          terminalTicks += 1;
          if (terminalTicks >= 2) {
            send("complete", run);
            clearInterval(interval);
            reply.raw.end();
          }
        } else {
          terminalTicks = 0;
        }
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : "Unable to stream run" });
      }
    };

    const interval = setInterval(poll, 500);
    request.raw.on("close", () => clearInterval(interval));
    poll();
  });

  if (options.webDirectory) {
    await app.register(fastifyStatic, {
      root: options.webDirectory,
      wildcard: false
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
