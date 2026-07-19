#!/usr/bin/env node
// Worker process (Spec 4 §2.2). Polls the Postgres `jobs` queue, claiming one
// job at a time with FOR UPDATE SKIP LOCKED, and drives it through the
// state machine (state_machine.ts). Runs everything long-running
// (yt-dlp/ffmpeg/OCR/ASR/Claude/Kroger); the `web` process never does.
//
// Run locally: `npm run worker` (tsx) — or the built dist entry in the
// Phase 4 container. Graceful shutdown on SIGTERM/SIGINT: stop claiming new
// jobs, let the in-flight one finish, then close the pool and exit.
import os from "node:os";
import crypto from "node:crypto";
import { logger } from "../platform/logger.js";
import { config } from "../platform/config.js";
import { closeDb } from "../platform/database.js";
import { migrateToLatest } from "../platform/migrate.js";
import { claimNextJob, requeueStaleJobs } from "../platform/jobs.js";
import { runJob } from "./state_machine.js";

const workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

let shuttingDown = false;
function requestShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("worker: shutdown requested, finishing in-flight job then exiting", {
    signal,
    workerId,
  });
}
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  logger.info("worker: starting", { workerId });
  // Ensure schema is present (idempotent) so a fresh DB / container boot works
  // without a separate migrate step.
  await migrateToLatest();

  let lastSweep = 0;
  while (!shuttingDown) {
    // Periodically reclaim jobs abandoned by a crashed worker.
    if (Date.now() - lastSweep > config.jobs.staleSweepIntervalMs) {
      try {
        const acted = await requeueStaleJobs();
        if (acted > 0) logger.info("worker: requeued stale jobs", { count: acted });
      } catch (err) {
        logger.error("worker: stale-sweep failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      lastSweep = Date.now();
    }

    let job;
    try {
      job = await claimNextJob(workerId);
    } catch (err) {
      logger.error("worker: claim failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(config.jobs.pollIntervalMs);
      continue;
    }

    if (!job) {
      await sleep(config.jobs.pollIntervalMs);
      continue;
    }

    // A thrown error inside runJob is already handled (job → Failed); this
    // catch is a last resort so one bad job never kills the worker loop.
    try {
      await runJob(job, workerId);
    } catch (err) {
      logger.error("worker: unhandled job error", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("worker: shut down cleanly", { workerId });
  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error("worker: fatal", { error: err instanceof Error ? err.message : String(err) });
  await closeDb();
  process.exit(1);
});
