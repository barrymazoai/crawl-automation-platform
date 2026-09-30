import fs from "node:fs/promises";
import path from "node:path";
import { OcrClient } from "@crawl-automation/ocr-client";
import { CodexProcessRunner, startChromeLane } from "@crawl-automation/runtime";
import { runAmazonPipeline } from "../src/amazon/pipeline.js";
import { runGncPipeline } from "../src/gnc/pipeline.js";
import { ProductObservationClient } from "../src/product-observation-client.js";
import { runSwansonPipeline } from "../src/swanson/pipeline.js";
import { SupplySmartDatabase } from "../src/supply-smart-ingest.js";

const channels = ["amazon", "gnc", "swanson"] as const;
type Channel = (typeof channels)[number];

const channel = process.argv[2] as Channel | undefined;
const url = process.argv[3];
const maxItems = Number.parseInt(process.argv[4] ?? "500", 10);
const runId = process.argv[5] ?? `${channel}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

if (!channel || !channels.includes(channel) || !url || !Number.isInteger(maxItems) || maxItems < 1) {
  throw new Error("usage: pnpm exec tsx scripts/mac/sales-channel-e2e.ts <amazon|gnc|swanson> <url> [max-items] [run-id]");
}

const required = ["PRODUCT_DATABASE_URL", "PRODUCT_SERVER_URL", "OCR_ENDPOINT"] as const;
for (const name of required) {
  if (!process.env[name]) throw new Error(`missing environment variable: ${name}`);
}

const repositoryRoot = path.resolve(process.env.REPOSITORY_ROOT ?? process.cwd());
const jobDirectory = process.env.E2E_JOB_DIRECTORY
  ? path.resolve(process.env.E2E_JOB_DIRECTORY)
  : path.resolve(process.env.WORK_ROOT ?? ".automation-runs", runId, `direct-${channel}`);
const profileRoot = path.resolve(process.env.SALES_CHANNEL_CHROME_PROFILE_ROOT ?? ".automation-state/e2e-chrome");
const signal = AbortSignal.timeout(Number.parseInt(process.env.E2E_TIMEOUT_MS ?? "14400000", 10));
await fs.mkdir(path.join(jobDirectory, "model"), { recursive: true });

const chrome = process.env.CHROME_CDP_URL ? null : await startChromeLane({
  id: Number.parseInt(process.env.E2E_CHROME_LANE_ID ?? "91", 10),
  profileRoot,
  ...(process.env.SALES_CHANNEL_CHROME_EXECUTABLE ? { executablePath: process.env.SALES_CHANNEL_CHROME_EXECUTABLE } : {}),
  headless: false,
});
if (chrome) process.env.CHROME_CDP_URL = chrome.cdpUrl;

const ocr = new OcrClient({ endpoint: process.env.OCR_ENDPOINT!, timeoutMs: 30_000, retries: 2 });
const supplySmart = SupplySmartDatabase.fromDatabaseUrl(process.env.PRODUCT_DATABASE_URL!);
const productWriter = new ProductObservationClient({
  baseUrl: process.env.PRODUCT_SERVER_URL!,
  ...(process.env.PRODUCT_SERVER_TOKEN ? { token: process.env.PRODUCT_SERVER_TOKEN } : {}),
  ...(process.env.PRODUCT_SERVER_API_KEY ? { apiKey: process.env.PRODUCT_SERVER_API_KEY } : {}),
});
const codex = new CodexProcessRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: process.env.CODEX_UNATTENDED_FULL_ACCESS === "true",
});

let modelCall = 0;
async function runModel({ prompt, tag }: { prompt: string; tag: string }) {
  modelCall += 1;
  const safeTag = `${String(modelCall).padStart(3, "0")}-${tag}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  const outputPath = path.join(jobDirectory, "model", `${safeTag}.result.json`);
  const result = await codex.run({
    prompt,
    cwd: repositoryRoot,
    addDirectories: [jobDirectory],
    schemaPath: path.join(repositoryRoot, "apps/backend/model-payload.schema.json"),
    outputPath,
    eventLogPath: path.join(jobDirectory, "model", `${safeTag}.events.jsonl`),
    signal,
  });
  if (!result || typeof result !== "object" || !("payload" in result) || typeof result.payload !== "string") {
    throw new Error(`Codex model output is invalid: ${safeTag}`);
  }
  return result.payload;
}

const common = {
  url,
  runId,
  jobDirectory,
  maxItems,
  ocrConcurrency: Number.parseInt(process.env.OCR_IMAGE_CONCURRENCY ?? "4", 10),
  signal,
  ocr,
  supplySmart,
  productWriter,
  runModel,
};

const startedAt = Date.now();
try {
  const result = channel === "amazon"
    ? await runAmazonPipeline(common)
    : channel === "gnc"
      ? await runGncPipeline({
          ...common,
          pdfRenderScript: path.resolve(process.env.GNC_PDF_RENDER_SCRIPT ?? "scripts/mac/render-pdf-pages.swift"),
        })
      : await runSwansonPipeline(common);
  console.log(JSON.stringify({
    channel,
    url,
    runId,
    jobDirectory,
    chromeCdpUrl: process.env.CHROME_CDP_URL,
    durationMs: Date.now() - startedAt,
    result,
  }, null, 2));
  if (result.status !== "complete") process.exitCode = 2;
} finally {
  await codex.close?.();
  await supplySmart.close();
  await chrome?.close();
}
