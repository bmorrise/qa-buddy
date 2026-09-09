import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { buildServer } from "./server.js";

const input = {
  name: "Example",
  githubUrl: "https://github.com/example/repository",
  defaultRef: "main",
  runnerImage: "node:22-bookworm",
  setupCommand: "npm ci",
  timeoutMinutes: 30,
  environmentAllowlist: [],
  apps: [
    {
      name: "App",
      workingDirectory: ".",
      testCommand: "npm test -- --coverage",
      coverageFormat: "istanbul-summary-json",
      coveragePath: "coverage/coverage-summary.json"
    }
  ]
};

describe("repository API", () => {
  let directory: string;
  let database: QaBuddyDatabase;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-api-"));
    database = new QaBuddyDatabase(path.join(directory, "test.sqlite"));
    app = await buildServer({ database, dataDirectory: directory });
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("validates, creates, lists, updates, and reads repositories", async () => {
    const invalid = await app.inject({ method: "POST", url: "/api/repositories", payload: { ...input, githubUrl: "git@example.com:bad" } });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: "/api/repositories", payload: input });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().repository.id as string;
    expect(created.json().repository.githubUrl).toBe("https://github.com/example/repository.git");

    const list = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(list.json().repositories).toHaveLength(1);

    const updated = await app.inject({ method: "PATCH", url: `/api/repositories/${repositoryId}`, payload: { ...input, name: "Updated" } });
    expect(updated.json().repository.name).toBe("Updated");
  });

  it("queues a run, rejects duplicates, and protects active repositories from deletion", async () => {
    const created = await app.inject({ method: "POST", url: "/api/repositories", payload: input });
    const repositoryId = created.json().repository.id as string;
    const run = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/runs`, payload: { ref: "feature/test" } });
    expect(run.statusCode).toBe(202);
    expect(run.json().run.requestedRef).toBe("feature/test");

    const duplicate = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/runs`, payload: {} });
    expect(duplicate.statusCode).toBe(409);

    const deletion = await app.inject({ method: "DELETE", url: `/api/repositories/${repositoryId}` });
    expect(deletion.statusCode).toBe(409);
  });

  it("queues only selected apps and rejects unknown selections", async () => {
    const multiAppInput = {
      ...input,
      apps: [
        input.apps[0],
        {
          ...input.apps[0],
          name: "API",
          workingDirectory: "apps/api",
          coveragePath: "apps/api/coverage/coverage-summary.json"
        }
      ]
    };
    const created = await app.inject({ method: "POST", url: "/api/repositories", payload: multiAppInput });
    const repositoryId = created.json().repository.id as string;

    const unknown = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/runs`,
      payload: { apps: ["Missing"] }
    });
    expect(unknown.statusCode).toBe(400);

    const selected = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/runs`,
      payload: { apps: ["API"] }
    });
    expect(selected.statusCode).toBe(202);
    expect(selected.json().run.selectedApps).toEqual(["API"]);
    expect(selected.json().run.appRuns.map((appRun: { name: string }) => appRun.name)).toEqual(["API"]);
  });

  it("returns health and not-found errors", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/runs/missing" })).statusCode).toBe(404);
  });

  it("downloads the complete redacted run log separately from the live view", async () => {
    const created = await app.inject({ method: "POST", url: "/api/repositories", payload: input });
    const repositoryId = created.json().repository.id as string;
    const queued = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/runs`, payload: {} });
    const runId = queued.json().run.id as string;
    mkdirSync(path.join(directory, "logs"), { recursive: true });
    writeFileSync(path.join(directory, "logs", `${runId}.log`), "full redacted log\n", "utf8");

    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}/log` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("full redacted log\n");
    expect(response.headers["content-disposition"]).toContain(`qa-buddy-run-${runId}.log`);
  });
});
