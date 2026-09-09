import { Worker, type Job } from "bullmq";
import { config as loadEnvironment } from "dotenv";
import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";

loadEnvironment({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

interface SyncJobPayload {
  syncRunId: string;
  syncDefinitionId: string;
  trigger: "manual" | "scheduled" | "retry";
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker<SyncJobPayload>(
  "sync-execution",
  async (job: Job<SyncJobPayload>) => {
    // The next vertical slice will resolve the definition, stream DHIS2 pages,
    // checkpoint the cursor, and write idempotent batches in a transaction.
    console.info(JSON.stringify({
      event: "sync_job_received",
      jobId: job.id,
      syncRunId: job.data.syncRunId,
      syncDefinitionId: job.data.syncDefinitionId,
      trigger: job.data.trigger
    }));
  },
  { connection, concurrency: 4 }
);

worker.on("completed", (job) => {
  console.info(JSON.stringify({ event: "sync_job_completed", jobId: job.id }));
});

worker.on("failed", (job, error) => {
  console.error(JSON.stringify({ event: "sync_job_failed", jobId: job?.id, message: error.message }));
});

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ event: "worker_shutdown", signal }));
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.info(JSON.stringify({ event: "worker_started", queue: "sync-execution", concurrency: 4 }));
