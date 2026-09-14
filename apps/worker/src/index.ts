import path from "node:path";
import Docker from "dockerode";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { QaBuddyWorker } from "./worker.js";
import { githubAuthenticationMessage, githubRegistryAuthenticationMessage } from "./git.js";

const dataDirectory = process.env.QA_BUDDY_DATA_DIR ?? path.resolve("data");
const workspaceDirectory = process.env.QA_BUDDY_WORKSPACE_DIR ?? path.resolve("workspaces");
const databasePath = process.env.QA_BUDDY_DATABASE_PATH ?? path.join(dataDirectory, "qa-buddy.sqlite");
const historyLimit = Math.max(1, Number(process.env.RUN_HISTORY_LIMIT ?? 20));
const githubToken = process.env.GITHUB_TOKEN || undefined;

const database = new QaBuddyDatabase(databasePath);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const worker = new QaBuddyWorker({
  database,
  docker,
  dataDirectory,
  workspaceDirectory,
  workspaceVolume: process.env.QA_BUDDY_WORKSPACE_VOLUME ?? "qa-buddy-workspaces",
  githubToken,
  historyLimit
});

const shutdown = async (): Promise<void> => {
  await worker.stop();
  database.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  console.info(githubAuthenticationMessage(githubToken));
  console.info(githubRegistryAuthenticationMessage(process.env.GITHUB_IDP_REGISTRY));
  await worker.run();
} catch (error) {
  console.error(error);
  database.close();
  process.exit(1);
}
