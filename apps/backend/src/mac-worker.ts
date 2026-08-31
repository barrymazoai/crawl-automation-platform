import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { OcrClient } from "@crawl-automation/ocr-client";
import {
  CodexProcessRunner,
  LocalCheckpointStore,
  NodeApiClient,
  fileSha256,
  runPool,
  startChromeLane,
  type ChromeLane,
  withLeaseHeartbeat,
} from "@crawl-automation/runtime";
import { runAmazonPipeline } from "./amazon/pipeline.js";
import { runDtcProcessing } from "./dtc-pipeline.js";
import { runGncPipeline } from "./gnc/pipeline.js";
import { runSwansonPipeline } from "./swanson/pipeline.js";
import { runGncCaptureCatalog } from "./v2/gnc-capture.js";
import { runAmazonCaptureCatalog } from "./v2/amazon-capture.js";
import { createAmazonChannelHooks } from "./v2/channels/amazon.js";
import { DiskGuard } from "./v2/disk-guard.js";
import {
  preserveQuarantineEvidence,
  runCatalogFinalizeStage,
  runIngestStagingStage,
  runProcessImagesStage,
  runProcessTextStage,
  runProductJoinStage,
  runProductUnifyStage,
  type ChannelHooks,
  type StageContext,
} from "./v2/stages.js";
import { createGncChannelHooks } from "./v2/channels/gnc.js";
import { productBatchSchema, SupplySmartDatabase, type ProductBatch } from "./supply-smart-ingest.js";
import { ProductObservationClient } from "./product-observation-client.js";
import { ClashControllerSelector } from "./sales-channel-egress/clash-controller.js";
import { SalesChannelEgressManager } from "./sales-channel-egress/manager.js";
import { SalesChannelEgressState } from "./sales-channel-egress/state.js";
import type { SalesChannelEgressPolicy } from "./sales-channel-egress/types.js";

const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const workerCapabilitySchema = z.enum([
  "amazon", "gnc", "swanson", "process", "ingest", "cleanup",
  "process_text", "process_images", "product_join", "product_unify",
  "catalog_finalize", "ingest_staging", "cleanup_run",
]);
const sourceAdapterSchema = z.enum(["amazon", "gnc", "swanson"]);

const env = z.object({
  CONTROL_PLANE_URL: z.url(),
  MAC_NODE_TOKEN: z.string().min(24),
  PRODUCT_DATABASE_URL: z.string().min(1),
  PRODUCT_SERVER_URL: z.url(),
  PRODUCT_SERVER_TOKEN: optionalSecret,
  PRODUCT_SERVER_API_KEY: optionalSecret,
  OCR_ENDPOINT: z.url(),
  NODE_ID: z.string().min(3).default("mac-mini-1"),
  NODE_NAME: z.string().default("Mac mini Processing Worker"),
  NODE_CAPABILITIES: z.string().default("amazon,gnc,swanson,process,ingest,cleanup"),
  NODE_SOURCE_ADAPTERS: z.string().optional(),
  // 阶段 3（方案 4）：上限放宽到 16，与控制面注册上限一致；每个 Pool 是独立进程，各配各的并发。
  NODE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  OCR_IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  // Codex 限流是账号级、跨进程的：各 Pool 静态切分预算（方案 4），总和不要超过账号实测限流。
  CODEX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  AMAZON_MAX_ITEMS: z.coerce.number().int().min(1).max(2000).default(500),
  GNC_MAX_ITEMS: z.coerce.number().int().min(1).max(5000).default(500),
  SWANSON_MAX_ITEMS: z.coerce.number().int().min(1).max(5000).default(2000),
  GNC_PDF_RENDER_SCRIPT: z.string().default(path.resolve("scripts/mac/render-pdf-pages.swift")),
  // v2 并行流水线：每个 Capture Batch 的商品数（计划 §5 建议 20~50），所有 Adapter 共用。
  V2_CAPTURE_BATCH_SIZE: z.coerce.number().int().min(5).max(100).default(25),
  // 方案 9：迁移期强制所有入库声明 partial，物理上杜绝缺席下架。验收通过（阶段 6）才允许改成 false。
  FORCE_PARTIAL_SCOPE: z.enum(["true", "false"]).default("true"),
  REVIEW_ROOT: z.string().default(path.resolve(".automation-review")),
  // 方案 6：磁盘背压阈值（GB），只作用于抓取。软阈值不领新目录；硬阈值暂停发布 Batch。
  DISK_SOFT_MIN_FREE_GB: z.coerce.number().min(1).max(1000).default(40),
  DISK_HARD_MIN_FREE_GB: z.coerce.number().min(1).max(1000).default(15),
  SALES_CHANNEL_EGRESS_ENABLED: z.enum(["true", "false"]).default("false"),
  SALES_CHANNEL_EGRESS_STATE_DB: z.string().default(path.resolve(".automation-state/sales-channel-egress.sqlite")),
  SALES_CHANNEL_EGRESS_PROFILE_ROOT: z.string().default(path.resolve(".automation-state/sales-channel-egress-chrome")),
  SALES_CHANNEL_CLASH_CONFIG_FILE: optionalSecret,
  SALES_CHANNEL_CLASH_CONTROLLER_URL: z.url().optional(),
  GNC_EGRESS_POOL: z.string().min(1).default("us-residential-4"),
  GNC_EGRESS_SELECTOR: z.string().min(1).default("GNC出口"),
  GNC_EGRESS_EXITS: z.string().default("texas=美国德州ip,washington=美国华盛顿ip,los-angeles=美国洛杉矶ip,redmond=美国雷德蒙德ip"),
  GNC_EGRESS_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  GNC_EGRESS_CHALLENGE_COOLDOWN_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(600_000),
  GNC_EGRESS_NETWORK_FAILURE_COOLDOWN_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(120_000),
  GNC_EGRESS_MAX_FAILURE_RETRIES: z.coerce.number().int().min(1).max(20).default(4),
  SALES_CHANNEL_CHROME_PROFILE_ROOT: z.string().default(path.resolve(".automation-state/chrome")),
  SALES_CHANNEL_CHROME_EXECUTABLE: z.string().optional(),
  WORK_ROOT: z.string().default(path.resolve(".automation-runs")),
  LOCAL_STATE_DB: z.string().default(path.resolve(".automation-state/mac.sqlite")),
  REPOSITORY_ROOT: z.string().default(process.cwd()),
  CODEX_EXECUTABLE: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.6-luna"),
  CODEX_REASONING_EFFORT: z.string().default("medium"),
  CODEX_UNATTENDED_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
}).parse(process.env);
const nodeCapabilities = z.array(workerCapabilitySchema).min(1).parse(
  [...new Set(env.NODE_CAPABILITIES.split(",").map((value) => value.trim()).filter(Boolean))],
);
const sourceAdapters = env.NODE_SOURCE_ADAPTERS
  ? z.array(sourceAdapterSchema).min(1).parse(
    [...new Set(env.NODE_SOURCE_ADAPTERS.split(",").map((value) => value.trim()).filter(Boolean))],
  )
  : undefined;

function parseEgressExits(value: string) {
  const exits = value.split(",").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`invalid_sales_channel_egress_exit:${entry}`);
    const id = entry.slice(0, separator).trim();
    const proxyName = entry.slice(separator + 1).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !proxyName) throw new Error(`invalid_sales_channel_egress_exit:${entry}`);
    return { id, proxyName };
  });
  if (exits.length === 0 || new Set(exits.map((exit) => exit.id)).size !== exits.length) {
    throw new Error("invalid_sales_channel_egress_exits");
  }
  return exits;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(action: () => Promise<T>) {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try { return await action(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const client = new NodeApiClient({ baseUrl: env.CONTROL_PLANE_URL, token: env.MAC_NODE_TOKEN, nodeId: env.NODE_ID });
const checkpoints = new LocalCheckpointStore(env.LOCAL_STATE_DB);
const ocr = new OcrClient({ endpoint: env.OCR_ENDPOINT, timeoutMs: 30_000, retries: 2 });
const supplySmart = SupplySmartDatabase.fromDatabaseUrl(env.PRODUCT_DATABASE_URL);
const productWriter = new ProductObservationClient({
  baseUrl: env.PRODUCT_SERVER_URL,
  ...(env.PRODUCT_SERVER_TOKEN ? { token: env.PRODUCT_SERVER_TOKEN } : {}),
  ...(env.PRODUCT_SERVER_API_KEY ? { apiKey: env.PRODUCT_SERVER_API_KEY } : {}),
});
const codex = new CodexProcessRunner({
  executable: env.CODEX_EXECUTABLE,
  model: env.CODEX_MODEL,
  reasoningEffort: env.CODEX_REASONING_EFFORT,
  unattendedFullAccess: env.CODEX_UNATTENDED_FULL_ACCESS === "true",
});
const codexSlots = new Semaphore(env.CODEX_CONCURRENCY);
const controller = new AbortController();
const active = new Set<string>();
const egressEnabled = env.SALES_CHANNEL_EGRESS_ENABLED === "true";
if (egressEnabled) {
  if (process.env.CHROME_CDP_URL) throw new Error("sales_channel_egress_requires_managed_chrome");
  if (!env.SALES_CHANNEL_CLASH_CONFIG_FILE) throw new Error("SALES_CHANNEL_CLASH_CONFIG_FILE is required when Sales Channel egress is enabled");
  if (!env.SALES_CHANNEL_CLASH_CONTROLLER_URL) throw new Error("SALES_CHANNEL_CLASH_CONTROLLER_URL is required when Sales Channel egress is enabled");
  if (env.NODE_MAX_CONCURRENCY !== 1 || sourceAdapters?.length !== 1 || sourceAdapters[0] !== "gnc") {
    throw new Error("sales_channel_egress_currently_requires_dedicated_gnc_worker");
  }
}
const clashConfig = egressEnabled
  ? z.object({ secret: z.union([z.string(), z.number()]).optional() }).passthrough().parse(
    parseYaml(await fs.readFile(env.SALES_CHANNEL_CLASH_CONFIG_FILE!, "utf8")),
  )
  : null;
const clashSelector = egressEnabled ? new ClashControllerSelector({
  baseUrl: env.SALES_CHANNEL_CLASH_CONTROLLER_URL!,
  secret: clashConfig?.secret?.toString() ?? "",
}) : null;
let managedChrome: ChromeLane | null = process.env.CHROME_CDP_URL || egressEnabled ? null : await startChromeLane({
  id: 1,
  profileRoot: env.SALES_CHANNEL_CHROME_PROFILE_ROOT,
  ...(env.SALES_CHANNEL_CHROME_EXECUTABLE ? { executablePath: env.SALES_CHANNEL_CHROME_EXECUTABLE } : {}),
  headless: false,
});
if (managedChrome) process.env.CHROME_CDP_URL = managedChrome.cdpUrl;

const egressState = egressEnabled ? new SalesChannelEgressState(env.SALES_CHANNEL_EGRESS_STATE_DB) : null;
const gncEgressPolicy: SalesChannelEgressPolicy | null = egressEnabled ? {
  channel: "gnc",
  pool: env.GNC_EGRESS_POOL,
  selector: env.GNC_EGRESS_SELECTOR,
  exits: parseEgressExits(env.GNC_EGRESS_EXITS),
  batchSize: env.GNC_EGRESS_BATCH_SIZE,
  challengeCooldownMs: env.GNC_EGRESS_CHALLENGE_COOLDOWN_MS,
  networkFailureCooldownMs: env.GNC_EGRESS_NETWORK_FAILURE_COOLDOWN_MS,
  maxFailureRetries: env.GNC_EGRESS_MAX_FAILURE_RETRIES,
} : null;
const egressManager = egressState && gncEgressPolicy ? new SalesChannelEgressManager({
  state: egressState,
  policies: [gncEgressPolicy],
  profileRoot: env.SALES_CHANNEL_EGRESS_PROFILE_ROOT,
  selectProxy: async ({ selector, proxyName }) => {
    await clashSelector!.select(selector, proxyName);
  },
  startBrowser: async ({ profileRoot }) => startChromeLane({
    id: 1,
    profileRoot,
    ...(env.SALES_CHANNEL_CHROME_EXECUTABLE ? { executablePath: env.SALES_CHANNEL_CHROME_EXECUTABLE } : {}),
    headless: false,
  }),
  onBrowserReady: (browser) => { process.env.CHROME_CDP_URL = browser.cdpUrl; },
}) : null;

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

function safeTag(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

async function uploadArtifact(claim: any, filename: string, kind: "evidence_bundle" | "codex_raw" | "normalized" | "review", contentType: string) {
  const stat = await fs.stat(filename);
  const hash = await fileSha256(filename);
  const created = await client.createArtifact(claim.job.id, claim.lease.token, {
    kind,
    fileName: path.basename(filename),
    contentType,
    sha256: hash,
    byteSize: stat.size,
  });
  await client.upload(created.uploadUrl, filename, hash, contentType);
  await client.confirmArtifact(created.artifact.id, claim.job.id, claim.lease.token);
  return created.artifact.id as string;
}

async function downloadInputArtifacts(claim: any, directory: string, kind: string) {
  const artifacts = claim.job.inputArtifacts.filter((artifact: any) => artifact.kind === kind);
  const outputs: Array<{ artifact: any; filename: string }> = [];
  for (const artifact of artifacts) {
    const target = path.join(directory, `${artifact.id}-${artifact.file_name}`);
    if (!await fs.stat(target).catch(() => null)) {
      const { downloadUrl } = await client.artifactDownload(artifact.id);
      await client.download(downloadUrl, target);
    }
    if (await fileSha256(target) !== artifact.sha256) throw new Error(`产物 ${artifact.id} 的 SHA256 不一致`);
    outputs.push({ artifact, filename: target });
  }
  return outputs;
}

async function runModelPayload(jobDirectory: string, prompt: string, tag: string, signal: AbortSignal) {
  return codexSlots.run(async () => {
    const name = safeTag(tag);
    const raw = await codex.run({
      prompt,
      cwd: env.REPOSITORY_ROOT,
      addDirectories: [jobDirectory],
      schemaPath: fileURLToPath(new URL("../model-payload.schema.json", import.meta.url)),
      outputPath: path.join(jobDirectory, "model", `${name}.result.json`),
      eventLogPath: path.join(jobDirectory, "model", `${name}.events.jsonl`),
      signal,
    });
    return z.object({ payload: z.string().min(2) }).parse(raw).payload;
  });
}

async function processDtc(claim: any, jobDirectory: string, signal: AbortSignal) {
  const downloads = await downloadInputArtifacts(claim, path.join(jobDirectory, "input"), "evidence_bundle");
  if (downloads.length === 0) throw new Error("process Job 没有 EvidenceBundle 输入");
  const eventLog = path.join(jobDirectory, "codex-process.events.jsonl");
  const result = await runDtcProcessing({
    sourceUrl: claim.job.source.url,
    runId: claim.job.runId,
    jobDirectory,
    archives: downloads.map((item) => item.filename),
    ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
    ocr,
    supplySmart,
    runProcessor: (prompt) => codexSlots.run(() => codex.run({
      prompt,
      cwd: env.REPOSITORY_ROOT,
      addDirectories: [jobDirectory],
      schemaPath: fileURLToPath(new URL("../process-result.schema.json", import.meta.url)),
      outputPath: path.join(jobDirectory, "process-result.json"),
      eventLogPath: eventLog,
      signal,
    })),
  });
  if (result.result.status !== "complete" || !result.batch || !result.batchFile) {
    return { review: result.result, imageCount: result.imageCount };
  }
  const artifactIds = [await uploadArtifact(claim, result.batchFile, "normalized", "application/json")];
  if (await fs.stat(eventLog).catch(() => null)) artifactIds.push(await uploadArtifact(claim, eventLog, "codex_raw", "application/x-ndjson"));
  return {
    artifactIds,
    itemCount: result.batch.products.length,
    factsCount: result.batch.facts.length,
    imageCount: result.imageCount,
    summary: result.result.summary,
  };
}

async function ingestDtc(claim: any, jobDirectory: string) {
  const downloads = await downloadInputArtifacts(claim, path.join(jobDirectory, "input"), "normalized");
  if (downloads.length === 0) throw new Error("ingest Job 没有 normalized 输入");
  const batches = await Promise.all(downloads.map(async (item) => productBatchSchema.parse(JSON.parse(await fs.readFile(item.filename, "utf8")))));
  const batch: ProductBatch = productBatchSchema.parse({
    schemaVersion: "2.0",
    products: batches.flatMap((value) => value.products),
    facts: batches.flatMap((value) => value.facts),
  });
  const result = await productWriter.ingestAndValidate(batch, { runId: claim.job.runId, sourceUrl: claim.job.source.url });
  await fs.writeFile(path.join(jobDirectory, "ingest-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (result.problems.length > 0 || result.verified !== batch.products.length) {
    return { review: { reasonCode: "product_db_ingest_review", summary: result.problems.slice(0, 20).join("; ") || "产品库回读数量不一致" } };
  }
  return { ingestedCount: result.verified, factsCount: batch.facts.length, readbackHash: result.readbackHash, validationPassed: true };
}

async function cleanupRun(claim: any) {
  const { artifacts } = await client.runArtifacts(claim.job.runId);
  for (const artifact of artifacts) await client.deleteArtifact(artifact.id, claim.job.id, claim.lease.token);
  await fs.rm(path.resolve(env.WORK_ROOT, claim.job.runId), { recursive: true, force: true });
  return { deletedArtifacts: artifacts.length, deletedLocalRun: true };
}

const V2_PROCESSING_STAGES = new Set(["process_text", "process_images", "product_join", "product_unify", "catalog_finalize", "ingest_staging", "cleanup_run"]);
// 抓取类 capability：v1 process（含抓取）与 v2 capture_catalog 都经由这些 capability 领取。
const CAPTURE_CAPABILITIES = new Set(["amazon", "gnc", "swanson", "browser"]);
const diskGuard = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});
// 渠道钩子注册表：阶段 4 迁移 Amazon/Swanson/DTC 时只在这里加一行 + 实现 v2/channels/<channel>.ts。
const v2Channels: Record<string, ChannelHooks<any, any, any>> = {
  gnc: createGncChannelHooks({ pdfRenderScript: env.GNC_PDF_RENDER_SCRIPT }),
  amazon: createAmazonChannelHooks(),
};

function v2StageContext(claim: any, jobDirectory: string, signal: AbortSignal): StageContext {
  return {
    workRoot: env.WORK_ROOT,
    runId: claim.job.runId,
    sourceUrl: claim.job.source.url,
    signal,
    ocr,
    supplySmart,
    productWriter,
    ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
    forcePartialScope: env.FORCE_PARTIAL_SCOPE === "true",
    runModel: ({ prompt, tag }) => runModelPayload(jobDirectory, prompt, tag, signal),
  };
}

async function failForReview(claim: any, reasonCode: string, summary: string) {
  await client.fail(claim.job.id, claim.lease.token, { code: reasonCode, message: summary, retryable: false, needsReview: true });
  checkpoints.save(claim.job.id, claim.job.stage, "needs_review", { reasonCode, summary }, claim.lease.token);
}

async function handle(claim: any) {
  const { job, lease } = claim;
  active.add(job.id);
  try {
    const jobDirectory = path.resolve(env.WORK_ROOT, job.runId, job.id);
    await fs.mkdir(jobDirectory, { recursive: true });
    checkpoints.save(job.id, job.stage, "leased", job.payload, lease.token);
    await client.start(job.id, lease.token);
    await withLeaseHeartbeat({ client, jobId: job.id, leaseToken: lease.token, signal: controller.signal }, async (signal) => {
      let output: any;
      if (job.stage === "process" && job.source.adapter === "amazon") {
        output = await runAmazonPipeline({
          url: job.source.url,
          runId: job.runId,
          jobDirectory,
          maxItems: env.AMAZON_MAX_ITEMS,
          ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
          signal,
          ocr,
          supplySmart,
          productWriter,
          runModel: ({ prompt, tag }) => runModelPayload(jobDirectory, prompt, tag, signal),
        });
        if (output.status === "needs_review") {
          await failForReview(claim, output.reasonCode, output.summary);
          return;
        }
      } else if (job.stage === "process" && job.source.adapter === "gnc") {
        if (egressManager) {
          const selection = await egressManager.prepare("gnc");
          console.log(JSON.stringify({ type: "sales_channel_egress_prepared", channel: "gnc", exitId: selection.exit.id, successCount: selection.successCount }));
        }
        output = await runGncPipeline({
          url: job.source.url,
          runId: job.runId,
          jobDirectory,
          maxItems: env.GNC_MAX_ITEMS,
          ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
          signal,
          ocr,
          supplySmart,
          productWriter,
          pdfRenderScript: env.GNC_PDF_RENDER_SCRIPT,
          runModel: ({ prompt, tag }) => runModelPayload(jobDirectory, prompt, tag, signal),
          ...(egressManager ? { rotation: egressManager.rotation("gnc") } : {}),
        });
        if (output.status === "needs_review") {
          await failForReview(claim, output.reasonCode, output.summary);
          return;
        }
      } else if (job.stage === "process" && job.source.adapter === "swanson") {
        output = await runSwansonPipeline({
          url: job.source.url,
          runId: job.runId,
          jobDirectory,
          maxItems: env.SWANSON_MAX_ITEMS,
          ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
          signal,
          ocr,
          supplySmart,
          productWriter,
          runModel: ({ prompt, tag }) => runModelPayload(jobDirectory, prompt, tag, signal),
        });
        if (output.status === "needs_review") {
          await failForReview(claim, output.reasonCode, output.summary);
          return;
        }
      } else if (job.stage === "process") {
        output = await processDtc(claim, jobDirectory, signal);
        if (output.review) {
          await failForReview(claim, output.review.reasonCode ?? "dtc_process_review", output.review.summary);
          return;
        }
      } else if (job.stage === "ingest") {
        output = await ingestDtc(claim, jobDirectory);
        if (output.review) {
          await failForReview(claim, output.review.reasonCode, output.review.summary);
          return;
        }
      } else if (job.stage === "cleanup") {
        output = await cleanupRun(claim);
      } else if (job.stage === "capture_catalog" && job.source.adapter === "gnc") {
        if (egressManager) {
          const selection = await egressManager.prepare("gnc");
          console.log(JSON.stringify({ type: "sales_channel_egress_prepared", channel: "gnc", exitId: selection.exit.id, successCount: selection.successCount }));
        }
        output = await runGncCaptureCatalog({
          url: job.source.url,
          runId: job.runId,
          workRoot: env.WORK_ROOT,
          maxItems: env.GNC_MAX_ITEMS,
          batchSize: env.V2_CAPTURE_BATCH_SIZE,
          signal,
          ...(egressManager ? { rotation: egressManager.rotation("gnc") } : {}),
          registerBatch: (batch) => client.registerCaptureBatch(job.id, lease.token, batch),
          finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, lease.token, catalog),
          beforePublish: () => diskGuard.waitForPublishAllowance(signal),
        });
        if (output.status === "needs_review") {
          await failForReview(claim, output.reasonCode, output.summary);
          return;
        }
      } else if (job.stage === "capture_catalog" && job.source.adapter === "amazon") {
        output = await runAmazonCaptureCatalog({
          url: job.source.url,
          runId: job.runId,
          workRoot: env.WORK_ROOT,
          maxItems: env.AMAZON_MAX_ITEMS,
          batchSize: env.V2_CAPTURE_BATCH_SIZE,
          signal,
          registerBatch: (batch) => client.registerCaptureBatch(job.id, lease.token, batch),
          finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, lease.token, catalog),
          beforePublish: () => diskGuard.waitForPublishAllowance(signal),
        });
        if (output.status === "needs_review") {
          await failForReview(claim, output.reasonCode, output.summary);
          return;
        }
      } else if (V2_PROCESSING_STAGES.has(job.stage) && job.source.adapter && v2Channels[job.source.adapter]) {
        const hooks = v2Channels[job.source.adapter]!;
        const ctx = v2StageContext(claim, jobDirectory, signal);
        if (job.stage === "process_text") output = await runProcessTextStage(hooks, ctx, job.payload);
        else if (job.stage === "process_images") output = await runProcessImagesStage(hooks, ctx, job.payload);
        else if (job.stage === "product_join") output = await runProductJoinStage(hooks, ctx, job.payload);
        else if (job.stage === "product_unify") output = await runProductUnifyStage(hooks, ctx, job.payload);
        else if (job.stage === "catalog_finalize") output = await runCatalogFinalizeStage(hooks, ctx, job.payload);
        else if (job.stage === "ingest_staging") {
          output = await runIngestStagingStage(hooks, ctx);
          if (output.status === "needs_review") {
            await failForReview(claim, output.reasonCode, output.summary);
            return;
          }
        } else {
          // cleanup_run：先把隔离证据搬到 REVIEW_ROOT 长期保留，再删 run 目录与远程产物。
          const preserved = await preserveQuarantineEvidence(ctx, env.REVIEW_ROOT);
          output = { ...await cleanupRun(claim), ...preserved };
        }
      } else {
        throw new Error(`Mac Worker 不支持 Job：${job.stage}`);
      }
      await client.complete(job.id, lease.token, output, `${job.stage}:${job.id}`);
      checkpoints.save(job.id, job.stage, "completed", output, lease.token);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.fail(job.id, lease.token, { code: `${job.stage}_worker_error`, message, retryable: true }).catch(() => {});
    checkpoints.save(job.id, job.stage, "failed", { error: message }, lease.token);
  } finally {
    active.delete(job.id);
  }
}

await client.register({
  name: env.NODE_NAME,
  platform: `${os.platform()} ${os.release()}`,
  version: "0.4.0",
  capabilities: nodeCapabilities,
  maxConcurrency: env.NODE_MAX_CONCURRENCY,
});
const heartbeat = setInterval(() => void client.heartbeat([...active]).catch(console.error), 30_000);
try {
  await runPool({
    concurrency: env.NODE_MAX_CONCURRENCY,
    signal: controller.signal,
    // 方案 6 软阈值：磁盘吃紧时不再领取抓取类任务（v1 process 与 v2 capture_catalog），
    // 处理/入库/清理 capability 照常领取——它们负责释放空间。
    claim: async () => {
      const captureCapable = nodeCapabilities.some((capability) => CAPTURE_CAPABILITIES.has(capability));
      if (captureCapable && !(await diskGuard.allowNewCatalog())) {
        const nonCapture = nodeCapabilities.filter((capability) => !CAPTURE_CAPABILITIES.has(capability));
        if (nonCapture.length === 0) return null;
        return client.claim(nonCapture, sourceAdapters);
      }
      return client.claim(nodeCapabilities, sourceAdapters);
    },
    handle,
    onError: console.error,
  });
} finally {
  clearInterval(heartbeat);
  await egressManager?.close();
  await clashSelector?.close();
  await managedChrome?.close();
  egressState?.close();
  checkpoints.close();
  await supplySmart.close();
}
