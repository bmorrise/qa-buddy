import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { QaBuddyDatabase } from "@qa-buddy/db";
import {
  appGroupInputSchema,
  appGroupOrderSchema,
  appGroupPatchSchema,
  coverageExportQuerySchema,
  coverageFileQuerySchema,
  coverageMetricNames,
  formatLineRanges,
  type CoverageExportRow,
  repositoryInputSchema,
  runRequestSchema,
  sliceBuildRequestSchema,
  sliceConfigSchema,
  terminalRunStatuses
} from "@qa-buddy/shared";
import { apiEndpoints } from "./api-reference.js";
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

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  // Semicolons and tabs are quoted too: some spreadsheet apps split on them.
  return /[",;\t\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per file with each metric's percent, covered, and total, ready for spreadsheets. */
export function coverageFilesCsv(files: CoverageExportRow[]): string {
  const header = [
    "file",
    "app",
    "slices",
    ...coverageMetricNames.flatMap((metric) => [`${metric}_percent`, `${metric}_covered`, `${metric}_total`]),
    "uncovered_functions",
    "uncovered_lines"
  ];
  const rows = files.map((file) => [
    file.path,
    file.appName,
    file.slices.join(", "),
    ...coverageMetricNames.flatMap((metric) => {
      const value = file[metric];
      return value ? [value.percent, value.covered, value.total] : [null, null, null];
    }),
    file.details ? file.details.uncoveredFunctions.map((fn) => `${fn.name} (line ${fn.line})`).join(", ") : null,
    file.details ? formatLineRanges(file.details.uncoveredLines) : null
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function fileSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
}

function logPath(dataDirectory: string, runId: string): string {
  return path.join(dataDirectory, "logs", `${runId}.log`);
}

const registeredRoutes = new WeakMap<FastifyInstance, Array<{ method: string; path: string }>>();

/** API routes the server registered, for checking the published reference. */
export function registeredApiRoutes(app: FastifyInstance): Array<{ method: string; path: string }> {
  return registeredRoutes.get(app) ?? [];
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const routes: Array<{ method: string; path: string }> = [];
  registeredRoutes.set(app, routes);
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api")) return;
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== "HEAD") routes.push({ method, path: route.url });
    }
  });
  const { database } = options;

  app.get("/api/health", async () => ({ status: "ok", service: "qa-buddy" }));

  app.get("/api", async () => ({
    service: "qa-buddy",
    description: "Local test-run and coverage dashboard. Paths are relative to this server; ids come from /api/repositories.",
    endpoints: apiEndpoints
  }));

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
      const sliceBuildIds = database.listSliceBuilds(request.params.repositoryId, 1_000).map((build) => build.id);
      const result = database.deleteRepository(request.params.repositoryId);
      if (result.active) {
        return reply.code(409).send({ error: "Wait for the active run to finish before deleting this repository" });
      }
      if (!result.deleted) return reply.code(404).send({ error: "Repository not found" });
      for (const runId of result.runIds) {
        rmSync(logPath(options.dataDirectory, runId), { force: true });
      }
      for (const buildId of sliceBuildIds) {
        rmSync(logPath(options.dataDirectory, `slice-build-${buildId}`), { force: true });
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
      if (parsed.data.useLocalWorkingTree && !repository.localPath) {
        return reply.code(400).send({
          error: "Add a local checkout path to this repository before running against the local working tree"
        });
      }
      try {
        const run = database.createRun(
          request.params.repositoryId,
          parsed.data.ref,
          parsed.data.apps,
          parsed.data.useLocalWorkingTree
        );
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
    "/api/repositories/:repositoryId/app-groups",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      return { appGroups: database.listAppGroups(request.params.repositoryId) };
    }
  );

  app.post<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/app-groups",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const parsed = appGroupInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      try {
        const appGroup = database.createAppGroup(request.params.repositoryId, parsed.data);
        return reply.code(201).send({ appGroup });
      } catch (error) {
        if (error instanceof Error && error.message.includes("already exists")) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.put<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/app-groups/order",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const parsed = appGroupOrderSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      const appGroups = database.reorderAppGroups(request.params.repositoryId, parsed.data.groupIds);
      if (!appGroups) {
        return reply.code(409).send({ error: "Groups changed since this page loaded. Refresh and try again." });
      }
      return { appGroups };
    }
  );

  app.patch<{ Params: { groupId: string } }>("/api/app-groups/:groupId", async (request, reply) => {
    const parsed = appGroupPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: issueMessage(parsed.error) });
    }
    try {
      const appGroup = database.updateAppGroup(request.params.groupId, parsed.data);
      if (!appGroup) return reply.code(404).send({ error: "Group not found" });
      return { appGroup };
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete<{ Params: { groupId: string } }>("/api/app-groups/:groupId", async (request, reply) => {
    if (!database.deleteAppGroup(request.params.groupId)) {
      return reply.code(404).send({ error: "Group not found" });
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/coverage",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      return { snapshots: database.listCoverageSnapshots(request.params.repositoryId) };
    }
  );

  app.get<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/coverage/history",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      return { entries: database.listCoverageHistory(request.params.repositoryId) };
    }
  );

  app.get<{ Params: { repositoryId: string }; Querystring: Record<string, string | undefined> }>(
    "/api/repositories/:repositoryId/coverage/files/export",
    async (request, reply) => {
      const repository = database.getRepository(request.params.repositoryId);
      if (!repository) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const parsed = coverageExportQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      const { format, app: appName, slice, metric, maxPercent, search } = parsed.data;
      const filters = { appName, sliceName: slice, metric, maxPercent, search };
      const files = database.exportCoverageFiles(repository.id, filters);
      const generatedAt = new Date().toISOString();
      const name = [fileSlug(repository.name), slice ? fileSlug(slice) : appName ? fileSlug(appName) : "all", "coverage-files", generatedAt.slice(0, 10)].join("-");
      if (format === "json") {
        return reply
          .header("content-disposition", `attachment; filename="${name}.json"`)
          .send({ repository: { id: repository.id, name: repository.name }, generatedAt, filters, total: files.length, files });
      }
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${name}.csv"`)
        .send(coverageFilesCsv(files));
    }
  );

  app.get<{ Params: { repositoryId: string }; Querystring: { path?: string } }>(
    "/api/repositories/:repositoryId/coverage/file",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const filePath = request.query.path?.trim();
      if (!filePath) {
        return reply.code(400).send({ error: "path: Enter a repository-relative file path" });
      }
      const file = database.getCoverageFile(request.params.repositoryId, filePath);
      if (!file) {
        return reply.code(404).send({ error: "No coverage snapshot lists this file" });
      }
      return { file };
    }
  );

  app.get<{
    Params: { repositoryId: string };
    Querystring: {
      app?: string;
      slice?: string;
      metric?: string;
      maxPercent?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/repositories/:repositoryId/coverage/files", async (request, reply) => {
    if (!database.getRepository(request.params.repositoryId)) {
      return reply.code(404).send({ error: "Repository not found" });
    }
    const parsed = coverageFileQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: issueMessage(parsed.error) });
    }
    return database.queryCoverageFiles(request.params.repositoryId, {
      appName: parsed.data.app,
      sliceName: parsed.data.slice,
      metric: parsed.data.metric,
      maxPercent: parsed.data.maxPercent,
      search: parsed.data.search,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });
  });


  // ----- Slices --------------------------------------------------------------------

  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/slices", async (request, reply) => {
    const { repositoryId } = request.params;
    if (!database.getRepository(repositoryId)) {
      return reply.code(404).send({ error: "Repository not found" });
    }
    return {
      config: database.getSliceConfig(repositoryId),
      builds: database.listSliceBuilds(repositoryId),
      slices: database.listSlices(repositoryId)
    };
  });

  app.put<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/slices/config",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const parsed = sliceConfigSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      return { config: database.setSliceConfig(request.params.repositoryId, parsed.data) };
    }
  );

  app.post<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/slices/builds",
    async (request, reply) => {
      const repository = database.getRepository(request.params.repositoryId);
      if (!repository) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const parsed = sliceBuildRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: issueMessage(parsed.error) });
      }
      if (!database.getSliceConfig(repository.id)) {
        return reply.code(400).send({ error: "Set up slices for this repository before building them" });
      }
      if (parsed.data.useLocalWorkingTree && !repository.localPath) {
        return reply.code(400).send({
          error: "Add a local checkout path to this repository before building from the local working tree"
        });
      }
      try {
        const build = database.createSliceBuild(repository.id, parsed.data.ref, parsed.data.useLocalWorkingTree);
        return reply.code(202).send({ build });
      } catch (error) {
        if (error instanceof Error && error.message.includes("already has")) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { repositoryId: string } }>(
    "/api/repositories/:repositoryId/slices/history",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      return { entries: database.listSliceHistory(request.params.repositoryId) };
    }
  );

  app.get<{ Params: { repositoryId: string; sliceName: string } }>(
    "/api/repositories/:repositoryId/slices/:sliceName",
    async (request, reply) => {
      if (!database.getRepository(request.params.repositoryId)) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const slice = database.getSlice(request.params.repositoryId, request.params.sliceName);
      if (!slice) {
        return reply.code(404).send({ error: "Slice not found" });
      }
      return { slice };
    }
  );

  app.get<{ Params: { buildId: string } }>("/api/slice-builds/:buildId/log", async (request, reply) => {
    if (!database.getSliceBuild(request.params.buildId)) {
      return reply.code(404).send({ error: "Slice build not found" });
    }
    const file = logPath(options.dataDirectory, `slice-build-${request.params.buildId}`);
    if (!existsSync(file)) return reply.type("text/plain").send("");
    return reply.type("text/plain").send(createReadStream(file));
  });

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


  app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", async (request, reply) => {
    const outcome = database.requestRunCancellation(request.params.runId);
    if (outcome === "not_found") {
      return reply.code(404).send({ error: "Run not found" });
    }
    if (outcome === "already_finished") {
      return reply.code(409).send({ error: "This run has already finished" });
    }
    return reply.code(202).send({
      run: database.getRun(request.params.runId),
      stopped: outcome === "stopped"
    });
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
