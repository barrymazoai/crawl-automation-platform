import path from "node:path";
import { z } from "zod";
import { mapWithConcurrency } from "../src/amazon/ocr-label-pipeline.js";
import { AmazonBackfillStagingWriter } from "../src/amazon/backfill-staging.js";
import { AmazonBackfillState } from "../src/amazon/backfill-state.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  concurrency: z.coerce.number().int().min(1).max(8).default(5),
  stateFile: z.string().min(1),
  runId: z.string().min(1),
  retryReason: z.string().min(1).optional(),
  retryLimit: z.coerce.number().int().min(1).max(10_000).default(20),
}).parse({
  limit: flag("--limit") ?? 20,
  concurrency: flag("--concurrency") ?? 5,
  stateFile: flag("--state") ?? path.resolve("reports", "amazon-backfill", "state.sqlite"),
  runId: flag("--run-id") ?? "amazon-backfill-amazon-evidence-2026-08-29",
  retryReason: flag("--retry-reason"),
  retryLimit: flag("--retry-limit") ?? 20,
});

const databaseUrl = process.env.STAGING_DATABASE_URL ?? process.env.PRODUCT_DATABASE_URL;
if (!databaseUrl) throw new Error("缺少 STAGING_DATABASE_URL/PRODUCT_DATABASE_URL");
const productServerUrl = process.env.PRODUCT_SERVER_URL;
if (!productServerUrl) throw new Error("缺少 PRODUCT_SERVER_URL");

const state = new AmazonBackfillState(cli.stateFile);
state.recoverInterrupted("staging");
const writer = new AmazonBackfillStagingWriter({
  databaseUrl,
  productServerUrl,
  ...(process.env.PRODUCT_SERVER_TOKEN ? { token: process.env.PRODUCT_SERVER_TOKEN } : {}),
  ...(process.env.PRODUCT_SERVER_API_KEY ? { apiKey: process.env.PRODUCT_SERVER_API_KEY } : {}),
  runId: cli.runId,
});

try {
  const retried = cli.retryReason ? state.retryStagingByReason(cli.retryReason, cli.retryLimit) : [];
  const claimed = state.claimStaging(cli.limit);
  const results = await mapWithConcurrency(claimed, cli.concurrency, async (task) => {
    try {
      const result = await writer.write(task);
      state.recordStaging(task.productId, result.status, result);
      return { productId: task.productId, ...result };
    } catch (error) {
      const result = { error: error instanceof Error ? error.message : String(error) };
      state.recordStaging(task.productId, "failed", result);
      return { productId: task.productId, status: "failed" as const, ...result };
    }
  });
  console.log(JSON.stringify({
    mode: "write_product_staging_only",
    productRestoreWrites: false,
    retried: retried.length,
    claimed: claimed.length,
    ready: results.filter((item) => item.status === "ready").length,
    review: results.filter((item) => item.status === "review").length,
    failed: results.filter((item) => item.status === "failed").length,
    staging: state.stagingSummary(),
  }, null, 2));
} finally {
  state.close();
  await writer.close();
}
