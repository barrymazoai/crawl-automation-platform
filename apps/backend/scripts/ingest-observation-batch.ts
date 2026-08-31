import fs from "node:fs/promises";
import path from "node:path";
import { ProductObservationClient } from "../src/product-observation-client.js";
import { productBatchSchema } from "../src/supply-smart-ingest.js";

const batchFile = process.argv[2];
const runId = process.argv[3];
const sourceUrl = process.argv[4];

if (!batchFile || !runId || !sourceUrl || !process.env.PRODUCT_SERVER_URL) {
  throw new Error("usage: PRODUCT_SERVER_URL=... pnpm exec tsx apps/backend/scripts/ingest-observation-batch.ts <batch-file> <run-id> <source-url>");
}

const batch = productBatchSchema.parse(JSON.parse(await fs.readFile(path.resolve(batchFile), "utf8")));
const client = new ProductObservationClient({
  baseUrl: process.env.PRODUCT_SERVER_URL,
  ...(process.env.PRODUCT_SERVER_TOKEN ? { token: process.env.PRODUCT_SERVER_TOKEN } : {}),
  ...(process.env.PRODUCT_SERVER_API_KEY ? { apiKey: process.env.PRODUCT_SERVER_API_KEY } : {}),
  timeoutMs: Number.parseInt(process.env.PRODUCT_SERVER_TIMEOUT_MS ?? "300000", 10),
  retries: Number.parseInt(process.env.PRODUCT_SERVER_RETRIES ?? "4", 10),
});

const startedAt = Date.now();
const result = await client.ingestAndValidate(batch, { runId, sourceUrl });
console.log(JSON.stringify({
  batchFile: path.resolve(batchFile),
  runId,
  sourceUrl,
  productCount: batch.products.length,
  factsCount: batch.facts.length,
  durationMs: Date.now() - startedAt,
  result,
}, null, 2));
if (result.problems.length > 0 || result.verified !== batch.products.length) process.exitCode = 2;
