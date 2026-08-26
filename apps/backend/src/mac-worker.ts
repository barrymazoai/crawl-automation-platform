import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EvidenceBundleV1Schema } from "@crawl-automation/contracts";
import { OcrClient } from "@crawl-automation/ocr-client";
import {
  CodexProcessRunner, LocalCheckpointStore, NodeApiClient, extractZipSafe, fileSha256, runPool, withLeaseHeartbeat, zipDirectory,
} from "@crawl-automation/runtime";
import { SupplySmartIngest, normalizedProductsSchema } from "./supply-smart-ingest.js";

const env = z.object({
  CONTROL_PLANE_URL: z.url(), MAC_NODE_TOKEN: z.string().min(24), PRODUCT_DATABASE_URL: z.string().min(1), OCR_ENDPOINT: z.url(),
  NODE_ID: z.string().min(3).default("mac-mini-1"), NODE_NAME: z.string().default("Mac mini Processing Worker"),
  NODE_MAX_CONCURRENCY: z.coerce.number().int().min(2).max(16).default(8),
  WORK_ROOT: z.string().default(path.resolve(".automation-runs")), LOCAL_STATE_DB: z.string().default(path.resolve(".automation-state/mac.sqlite")),
  REPOSITORY_ROOT: z.string().default(process.cwd()), CODEX_EXECUTABLE: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.6-luna"), CODEX_REASONING_EFFORT: z.string().default("medium"),
  CODEX_UNATTENDED_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
}).parse(process.env);

const resultSchema = z.object({ status: z.enum(["complete", "needs_review", "failed"]), recordsFile: z.string().min(1), outputCount: z.number().int().nonnegative(), summary: z.string(), reasonCode: z.string().nullable().optional() });
const client = new NodeApiClient({ baseUrl: env.CONTROL_PLANE_URL, token: env.MAC_NODE_TOKEN, nodeId: env.NODE_ID });
const checkpoints = new LocalCheckpointStore(env.LOCAL_STATE_DB);
const ocr = new OcrClient({ endpoint: env.OCR_ENDPOINT, timeoutMs: 15_000, retries: 1 });
const codex = new CodexProcessRunner({ executable: env.CODEX_EXECUTABLE, model: env.CODEX_MODEL, reasoningEffort: env.CODEX_REASONING_EFFORT, unattendedFullAccess: env.CODEX_UNATTENDED_FULL_ACCESS === "true" });
const ingest = SupplySmartIngest.fromDatabaseUrl(env.PRODUCT_DATABASE_URL);
const controller = new AbortController(); const active = new Set<string>();
process.on("SIGINT", () => controller.abort()); process.on("SIGTERM", () => controller.abort());

async function uploadArtifact(claim: any, filename: string, kind: "evidence_bundle" | "ocr_bundle" | "codex_raw" | "normalized" | "review", contentType: string) {
  const stat = await fs.stat(filename); const hash = await fileSha256(filename);
  const created = await client.createArtifact(claim.job.id, claim.lease.token, { kind, fileName: path.basename(filename), contentType, sha256: hash, byteSize: stat.size });
  await client.upload(created.uploadUrl, filename, hash, contentType);
  await client.confirmArtifact(created.artifact.id, claim.job.id, claim.lease.token);
  return created.artifact.id as string;
}

async function downloadInputArtifacts(claim: any, directory: string, kind?: string) {
  const artifacts = kind ? claim.job.inputArtifacts.filter((artifact: any) => artifact.kind === kind) : claim.job.inputArtifacts;
  const outputs = [];
  for (const artifact of artifacts) {
    const target = path.join(directory, `${artifact.id}-${artifact.file_name}`);
    if (!await fs.stat(target).catch(() => null)) {
      const { downloadUrl } = await client.artifactDownload(artifact.id); await client.download(downloadUrl, target);
    }
    if (await fileSha256(target) !== artifact.sha256) throw new Error(`产物 ${artifact.id} 的 SHA256 不一致`);
    outputs.push({ artifact, filename: target });
  }
  return outputs;
}

async function mapLimit<T>(items: T[], limit: number, action: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; await action(items[index]!); }
  }));
}

async function processOcr(claim: any, jobDirectory: string) {
  const downloads = await downloadInputArtifacts(claim, path.join(jobDirectory, "input"), "evidence_bundle");
  const outputIds: string[] = [];
  for (const [index, item] of downloads.entries()) {
    const evidence = path.join(jobDirectory, `evidence-${index}`); await extractZipSafe(item.filename, evidence);
    const images: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(filename);
        else if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) images.push(filename);
      }
    };
    await walk(evidence);
    await mapLimit(images, 4, async (filename) => {
      const cache = `${filename}.ocr.json`;
      if (!await fs.stat(cache).catch(() => null)) await fs.writeFile(cache, `${JSON.stringify(await ocr.recognize(filename), null, 2)}\n`);
    });
    const archive = await zipDirectory(evidence, path.join(jobDirectory, "output", `ocr-${index}.zip`));
    outputIds.push(await uploadArtifact(claim, archive.filename, "ocr_bundle", "application/zip"));
  }
  return { artifactIds: outputIds, bundleCount: outputIds.length };
}

function amazonAsins(url: string, html: string) {
  const direct = new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  const discovered = [...html.matchAll(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?"'])/gi)].map((match) => match[1]!.toUpperCase());
  return [...new Set([...(direct ? [direct.toUpperCase()] : []), ...discovered])].slice(0, 500);
}

async function processAmazon(claim: any, jobDirectory: string) {
  const url = claim.job.source.url as string;
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; SupplySmartProductAdapter/1.0)", "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Amazon adapter HTTP ${response.status}`);
  const html = await response.text();
  if (/captcha|enter the characters you see|robot check/i.test(html)) throw new Error("Amazon adapter 遇到挑战页面");
  const asins = amazonAsins(url, html); if (!asins.length) throw new Error("Amazon adapter 未发现 ASIN");
  const evidence = path.join(jobDirectory, "evidence"); await fs.mkdir(path.join(evidence, "pages"), { recursive: true });
  await fs.writeFile(path.join(evidence, "pages", "source.html"), html);
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "Amazon product";
  const items = asins.map((asin) => ({ externalId: asin, productUrl: `https://www.amazon.com/dp/${asin}`, title, sku: null, skuMissing: true, variant: {}, sourceFiles: ["pages/source.html"], imageFiles: [] }));
  await fs.writeFile(path.join(evidence, "items.jsonl"), `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const pageHash = await fileSha256(path.join(evidence, "pages", "source.html")); const pageStat = await fs.stat(path.join(evidence, "pages", "source.html"));
  const bundle = EvidenceBundleV1Schema.parse({ schemaVersion: "1.0", runId: claim.job.runId, batchId: randomUUID(), ordinal: 0, sourceUrl: url,
    sourceType: "sales_channel", adapter: "amazon", capturedAt: new Date().toISOString(), itemCount: items.length, items,
    files: [{ path: "pages/source.html", sha256: pageHash, byteSize: pageStat.size, mediaType: "text/html" }],
    capture: { nodeId: env.NODE_ID, promptVersion: "amazon-adapter-v1", skillRevision: null, pageCount: 1, complete: true } });
  await fs.writeFile(path.join(evidence, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  const archive = await zipDirectory(evidence, path.join(jobDirectory, "output", "amazon-evidence.zip"));
  const artifactId = await uploadArtifact(claim, archive.filename, "evidence_bundle", "application/zip");
  return { itemCount: items.length, artifactIds: [artifactId], adapter: "amazon" };
}

function normalizePrompt(input: { url: string; evidenceDirectories: string[]; outputFile: string }) {
  return `你是 Mac 数据规范化 Worker，不操作浏览器。开始前拉取 crawl-products Skill 的最新代码并完整读取。\n网站：${input.url}\n证据目录：${input.evidenceDirectories.join("\n")}\n输出文件：${input.outputFile}\n\n读取页面证据、图片及每张图片旁的 .ocr.json。按 nutrition_single_products 做范围终判；非营养品、Bundle/Pack/Kit 和缺少 ingredients/formula 的商品必须排除。每个可售变体输出为独立产品，保留真实 SKU；缺失时 sku=null、skuMissing=true。输出必须与 Link Monitor/Supply Smart 一致，包含 domain、productName、productUrl、channel、externalId、sourceUrl、capturedAt、crawlScope、source、sku、skuMissing、price/currency、rating/reviewCount、salesRank/inStock、images、healthFunctions、mainIngredients、productForm、nutritionScope、variantAttrs、family。把合法 JSON 数组写入输出文件。证据冲突或无法形成稳定 externalId 时返回 needs_review，禁止猜测。`;
}

async function processNormalize(claim: any, jobDirectory: string, signal: AbortSignal) {
  const downloads = await downloadInputArtifacts(claim, path.join(jobDirectory, "input"), "ocr_bundle");
  const directories: string[] = [];
  for (const [index, item] of downloads.entries()) { const target = path.join(jobDirectory, `evidence-${index}`); await extractZipSafe(item.filename, target); directories.push(target); }
  const outputFile = path.join(jobDirectory, "normalized-products.json"); const resultFile = path.join(jobDirectory, "normalize-result.json"); const eventLog = path.join(jobDirectory, "codex-events.jsonl");
  const raw = await codex.run({ prompt: normalizePrompt({ url: claim.job.source.url, evidenceDirectories: directories, outputFile }), cwd: env.REPOSITORY_ROOT,
    addDirectories: [jobDirectory], schemaPath: fileURLToPath(new URL("../normalize-result.schema.json", import.meta.url)), outputPath: resultFile, eventLogPath: eventLog, signal });
  const result = resultSchema.parse(raw);
  if (result.status !== "complete") return { review: result };
  const resolved = path.resolve(jobDirectory, result.recordsFile); if (!resolved.startsWith(`${jobDirectory}${path.sep}`)) throw new Error("规范化输出路径越界");
  const products = normalizedProductsSchema.parse(JSON.parse(await fs.readFile(resolved, "utf8")));
  if (products.length !== result.outputCount) throw new Error("规范化输出数量不一致");
  const normalizedId = await uploadArtifact(claim, resolved, "normalized", "application/json");
  const rawId = await uploadArtifact(claim, eventLog, "codex_raw", "application/x-ndjson");
  return { artifactIds: [normalizedId, rawId], outputCount: products.length, summary: result.summary };
}

async function handle(claim: any) {
  const { job, lease } = claim; active.add(job.id); const jobDirectory = path.resolve(env.WORK_ROOT, job.runId, job.id);
  await fs.mkdir(jobDirectory, { recursive: true }); checkpoints.save(job.id, job.stage, "leased", job.payload, lease.token); await client.start(job.id, lease.token);
  try {
    await withLeaseHeartbeat({ client, jobId: job.id, leaseToken: lease.token, signal: controller.signal }, async (signal) => {
      let output: any;
      if (job.stage === "capture" && job.source.adapter === "amazon") output = await processAmazon(claim, jobDirectory);
      else if (job.stage === "ocr") output = await processOcr(claim, jobDirectory);
      else if (job.stage === "normalize") {
        output = await processNormalize(claim, jobDirectory, signal);
        if (output.review) { await client.fail(job.id, lease.token, { code: output.review.reasonCode ?? "normalize_review", message: output.review.summary, retryable: false, needsReview: true }); return; }
      } else if (job.stage === "ingest") {
        const downloads = await downloadInputArtifacts(claim, path.join(jobDirectory, "input"), "normalized");
        const products = [];
        for (const item of downloads) products.push(...normalizedProductsSchema.parse(JSON.parse(await fs.readFile(item.filename, "utf8"))));
        const result = await ingest.ingestAndValidate(products);
        if (result.problems.length || result.verified !== products.length) throw new Error(`入库回读失败：${result.problems.join("; ")}`);
        output = { ingestedCount: result.verified, readbackHash: result.readbackHash, validationPassed: true };
      } else if (job.stage === "cleanup") {
        const { artifacts } = await client.runArtifacts(job.runId);
        for (const artifact of artifacts) await client.deleteArtifact(artifact.id, job.id, lease.token);
        await fs.rm(path.resolve(env.WORK_ROOT, job.runId), { recursive: true, force: true }); output = { deletedArtifacts: artifacts.length };
      } else throw new Error(`不支持的 Job：${job.stage}`);
      await client.complete(job.id, lease.token, output, `${job.stage}:${job.id}`); checkpoints.save(job.id, job.stage, "completed", output, lease.token);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); const adapterFailure = job.stage === "capture" && job.source.adapter;
    await client.fail(job.id, lease.token, { code: adapterFailure ? "amazon_adapter_failed" : `${job.stage}_worker_error`, message, retryable: !adapterFailure }).catch(() => {});
    checkpoints.save(job.id, job.stage, "failed", { error: message }, lease.token);
  } finally { active.delete(job.id); }
}

await client.register({ name: env.NODE_NAME, platform: `${os.platform()} ${os.release()}`, version: "0.2.0",
  capabilities: ["sales_channel", "ocr", "text_codex", "normalize", "ingest", "cleanup"], maxConcurrency: env.NODE_MAX_CONCURRENCY });
const heartbeat = setInterval(() => void client.heartbeat([...active]).catch(console.error), 30_000);
const pools = [
  runPool({ concurrency: 2, signal: controller.signal, claim: () => client.claim(["sales_channel"]), handle, onError: console.error }),
  runPool({ concurrency: 1, signal: controller.signal, claim: () => client.claim(["ocr"]), handle, onError: console.error }),
  runPool({ concurrency: 2, signal: controller.signal, claim: () => client.claim(["normalize"]), handle, onError: console.error }),
  runPool({ concurrency: 1, signal: controller.signal, claim: () => client.claim(["ingest"]), handle, onError: console.error }),
  runPool({ concurrency: 1, signal: controller.signal, claim: () => client.claim(["cleanup"]), handle, onError: console.error }),
];
try { await Promise.all(pools); } finally { clearInterval(heartbeat); checkpoints.close(); await ingest.close(); }
