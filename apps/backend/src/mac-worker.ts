import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { OcrClient } from "@crawl-automation/ocr-client";
import {
  CodexProcessRunner,
  LocalCheckpointStore,
  NodeApiClient,
  fileSha256,
  runPool,
  withLeaseHeartbeat,
} from "@crawl-automation/runtime";
import { runAmazonPipeline } from "./amazon/pipeline.js";
import { runDtcProcessing } from "./dtc-pipeline.js";
import { productBatchSchema, SupplySmartDatabase, type ProductBatch } from "./supply-smart-ingest.js";

const env = z.object({
  CONTROL_PLANE_URL: z.url(),
  MAC_NODE_TOKEN: z.string().min(24),
  PRODUCT_DATABASE_URL: z.string().min(1),
  OCR_ENDPOINT: z.url(),
  NODE_ID: z.string().min(3).default("mac-mini-1"),
  NODE_NAME: z.string().default("Mac mini Processing Worker"),
  NODE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  OCR_IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  CODEX_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  AMAZON_MAX_ITEMS: z.coerce.number().int().min(1).max(2000).default(500),
  WORK_ROOT: z.string().default(path.resolve(".automation-runs")),
  LOCAL_STATE_DB: z.string().default(path.resolve(".automation-state/mac.sqlite")),
  REPOSITORY_ROOT: z.string().default(process.cwd()),
  CODEX_EXECUTABLE: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.6-luna"),
  CODEX_REASONING_EFFORT: z.string().default("medium"),
  CODEX_UNATTENDED_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
}).parse(process.env);

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
const codex = new CodexProcessRunner({
  executable: env.CODEX_EXECUTABLE,
  model: env.CODEX_MODEL,
  reasoningEffort: env.CODEX_REASONING_EFFORT,
  unattendedFullAccess: env.CODEX_UNATTENDED_FULL_ACCESS === "true",
});
const codexSlots = new Semaphore(env.CODEX_CONCURRENCY);
const controller = new AbortController();
const active = new Set<string>();

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
  const result = await supplySmart.ingestAndValidate(batch);
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

async function failForReview(claim: any, reasonCode: string, summary: string) {
  await client.fail(claim.job.id, claim.lease.token, { code: reasonCode, message: summary, retryable: false, needsReview: true });
  checkpoints.save(claim.job.id, claim.job.stage, "needs_review", { reasonCode, summary }, claim.lease.token);
}

async function handle(claim: any) {
  const { job, lease } = claim;
  active.add(job.id);
  const jobDirectory = path.resolve(env.WORK_ROOT, job.runId, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  checkpoints.save(job.id, job.stage, "leased", job.payload, lease.token);
  await client.start(job.id, lease.token);
  try {
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
  capabilities: ["amazon", "process", "ingest", "cleanup"],
  maxConcurrency: env.NODE_MAX_CONCURRENCY,
});
const heartbeat = setInterval(() => void client.heartbeat([...active]).catch(console.error), 30_000);
try {
  await runPool({
    concurrency: env.NODE_MAX_CONCURRENCY,
    signal: controller.signal,
    claim: () => client.claim(["amazon", "process", "ingest", "cleanup"]),
    handle,
    onError: console.error,
  });
} finally {
  clearInterval(heartbeat);
  checkpoints.close();
  await supplySmart.close();
}
