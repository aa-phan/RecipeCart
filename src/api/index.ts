// API process entry point (Spec 4 §2.5). Separate process from the worker —
// the web/API process never runs yt-dlp/ffmpeg/Claude directly (Spec 4 §2.2).
import { buildServer } from "./server.js";
import { closeDb } from "../platform/database.js";
import { config } from "../platform/config.js";

async function main(): Promise<void> {
  const app = await buildServer();
  const port = config.apiPort;
  const host = "0.0.0.0";

  await app.listen({ port, host });
  app.log.info(`RecipeCart API listening on http://${host}:${port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
