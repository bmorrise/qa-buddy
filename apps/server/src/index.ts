import path from "node:path";
import { fileURLToPath } from "node:url";
import { QaBuddyDatabase } from "@qa-buddy/db";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3003);
const host = process.env.HOST ?? "0.0.0.0";
const dataDirectory = process.env.QA_BUDDY_DATA_DIR ?? path.resolve("data");
const databasePath = process.env.QA_BUDDY_DATABASE_PATH ?? path.join(dataDirectory, "qa-buddy.sqlite");
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWebDirectory = path.resolve(currentDirectory, "../../web/dist");
const webDirectory = process.env.QA_BUDDY_WEB_DIR ?? defaultWebDirectory;

const database = new QaBuddyDatabase(databasePath);
const app = await buildServer({
  database,
  dataDirectory,
  webDirectory,
  logger: true
});

const shutdown = async (): Promise<void> => {
  await app.close();
  database.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  database.close();
  process.exit(1);
}
