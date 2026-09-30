import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OcrClient } from "@crawl-automation/ocr-client";
import { CodexProcessRunner, startChromeLane } from "@crawl-automation/runtime";
import { runAmazonPipeline } from "../src/amazon/pipeline.js";
import type { ProductObservationClient } from "../src/product-observation-client.js";
import { SupplySmartDatabase } from "../src/supply-smart-ingest.js";

const url = process.argv[2];
if (!url) throw new Error("usage: tsx scripts/amazon-product-json.ts <amazon-product-url> [output-directory]");
const asin = new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
if (!asin) throw new Error("URL 中没有合法 ASIN");
if (!process.env.PRODUCT_DATABASE_URL || !process.env.OCR_ENDPOINT) throw new Error("缺少 PRODUCT_DATABASE_URL 或 OCR_ENDPOINT");

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(backendRoot, "../..");
const runId = `amazon-json-${asin}-${Date.now()}`;
const jobDirectory = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve("reports/amazon-product-json", runId);
await fs.mkdir(path.join(jobDirectory, "model"), { recursive: true });

const chrome = await startChromeLane({
  id: 92,
  profileRoot: path.resolve(process.env.SALES_CHANNEL_CHROME_PROFILE_ROOT ?? ".automation-state/amazon-json-chrome"),
  headless: false,
});
process.env.CHROME_CDP_URL = chrome.cdpUrl;

const ocr = new OcrClient({ endpoint: process.env.OCR_ENDPOINT, timeoutMs: 30_000, retries: 2 });
const supplySmart = SupplySmartDatabase.fromDatabaseUrl(process.env.PRODUCT_DATABASE_URL);
if (process.env.COMPANY_DOMAIN_OVERRIDE) supplySmart.resolveCompanyDomain = async () => process.env.COMPANY_DOMAIN_OVERRIDE!;
const codex = new CodexProcessRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: false,
});
const writer = {
  async ingestAndValidate(batch: unknown) {
    const products = Array.isArray((batch as { products?: unknown[] }).products) ? (batch as { products: unknown[] }).products.length : 0;
    return {
      loaded: products,
      verified: products,
      problems: [],
      records: [],
      readbackHash: createHash("sha256").update(JSON.stringify(batch)).digest("hex"),
      scope: "partial" as const,
      deactivated: 0,
    };
  },
} as unknown as ProductObservationClient;

let call = 0;
try {
  const result = await runAmazonPipeline({
    url,
    runId,
    jobDirectory,
    maxItems: 1,
    ocrConcurrency: 4,
    signal: AbortSignal.timeout(30 * 60_000),
    ocr,
    supplySmart,
    productWriter: writer,
    runModel: async ({ prompt, tag }) => {
      call += 1;
      const name = `${String(call).padStart(2, "0")}-${tag}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const result = await codex.run({
        prompt,
        cwd: repositoryRoot,
        addDirectories: [jobDirectory],
        schemaPath: path.join(backendRoot, "model-payload.schema.json"),
        outputPath: path.join(jobDirectory, "model", `${name}.result.json`),
        eventLogPath: path.join(jobDirectory, "model", `${name}.events.jsonl`),
      });
      if (!result || typeof result !== "object" || typeof (result as { payload?: unknown }).payload !== "string") throw new Error(`${tag}: Codex 输出无 payload`);
      return (result as { payload: string }).payload;
    },
  });
  console.log(JSON.stringify({ mode: "json_only", databaseWrites: false, asin, result, productJson: path.join(jobDirectory, "amazon/product-batch.json") }, null, 2));
} finally {
  await codex.close?.();
  await supplySmart.close();
  await chrome.close();
}
