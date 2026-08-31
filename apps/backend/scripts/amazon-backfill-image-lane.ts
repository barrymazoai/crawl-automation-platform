import fs from "node:fs/promises";
import path from "node:path";
import { OcrClient } from "@crawl-automation/ocr-client";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { buildAmazonImageEvidence, createR2ImageUrlResolver, type AmazonBackfillImageRow } from "../src/amazon/backfill-image.js";
import { AmazonBackfillState } from "../src/amazon/backfill-state.js";
import { mapWithConcurrency } from "../src/amazon/ocr-label-pipeline.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  productConcurrency: z.coerce.number().int().min(1).max(16).default(2),
  imageConcurrency: z.coerce.number().int().min(1).max(32).default(5),
  outputDirectory: z.string().min(1),
  stateFile: z.string().min(1),
  retryReport: z.string().min(1).optional(),
}).parse({
  limit: flag("--limit") ?? 20,
  productConcurrency: flag("--product-concurrency") ?? 2,
  imageConcurrency: flag("--image-concurrency") ?? 5,
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", "amazon-backfill-dry-run"),
  stateFile: flag("--state") ?? path.resolve("reports", "amazon-backfill-dry-run", "state.sqlite"),
  retryReport: flag("--retry-report"),
});

const snapshotFile = path.resolve(process.env.BACKFILL_SOURCE_SNAPSHOT ?? path.join(path.dirname(cli.stateFile), "source-evidence.sqlite"));
const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
const snapshotMeta = Object.fromEntries((snapshot.prepare("select key,value from snapshot_meta").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
if (snapshotMeta.complete !== "true") throw new Error(`源证据快照不完整：${snapshotFile}`);
const endpoint = process.env.OCR_ENDPOINT;
if (!endpoint) throw new Error("缺少 OCR_ENDPOINT；图片 Lane 不会调用未明确配置的 OCR 服务");

interface ImageDbRow {
  id: string;
  product_id: string;
  image_url: string;
}

const state = new AmazonBackfillState(cli.stateFile);
const ocr = new OcrClient({ endpoint, timeoutMs: 30_000, retries: 2 });
const resolveImageUrl = createR2ImageUrlResolver();

try {
  state.recoverInterrupted("image");
  if (cli.retryReport) {
    const previous = JSON.parse(await fs.readFile(cli.retryReport, "utf8")) as {
      results?: Array<{ productId?: unknown; ocrFailed?: unknown }>;
    };
    for (const item of previous.results ?? []) {
      if (typeof item.productId === "string" && Number(item.ocrFailed) > 0) state.retryImage(item.productId);
    }
  }
  const claimed = state.claimImage(cli.limit);
  const productIds = claimed.map((item) => item.productId);
  const result = { rows: productIds.length === 0 ? [] as ImageDbRow[] : snapshot.prepare(`
    select id,product_id,image_url from source_image
    where product_id in (${productIds.map(() => "?").join(",")})
    order by product_id,image_index,id
  `).all(...productIds) as unknown as ImageDbRow[] };
  const byProduct = new Map<string, AmazonBackfillImageRow[]>();
  for (const row of result.rows) {
    const images = byProduct.get(row.product_id) ?? [];
    images.push({ id: row.id, productId: row.product_id, imageUrl: row.image_url });
    byProduct.set(row.product_id, images);
  }

  const evidenceDirectory = path.join(cli.outputDirectory, "image-evidence");
  const cacheDirectory = path.join(cli.outputDirectory, "image-cache");
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const laneResults = await mapWithConcurrency(claimed, cli.productConcurrency, async (task) => {
    const images = byProduct.get(task.productId) ?? [];
    if (images.length === 0) {
      state.recordImage(task.productId, "review", null, { reasons: ["image_rows_missing_after_claim"] });
      return { productId: task.productId, status: "review", factsCandidates: 0, ocrFailed: 0 };
    }
    const evidence = await buildAmazonImageEvidence({
      productId: task.productId,
      images,
      cacheDirectory,
      imageConcurrency: cli.imageConcurrency,
      recognize: (filename) => ocr.recognize(filename),
      resolveImageUrl,
    });
    const evidenceFile = path.join(evidenceDirectory, `${task.productId}.json`);
    await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
    if (evidence.ocrSucceeded === 0) {
      state.recordImage(task.productId, "failed", { evidenceFile }, { reasons: ["all_image_ocr_failed"], failures: evidence.failures });
      return { productId: task.productId, status: "failed", factsCandidates: 0, ocrFailed: evidence.ocrFailed };
    }
    if (evidence.ocrFailed > 0) {
      state.recordImage(task.productId, "review", { evidenceFile }, {
        reasons: ["partial_image_ocr_failed"],
        failures: evidence.failures,
      });
      return { productId: task.productId, status: "review", factsCandidates: evidence.factsCandidates.length, ocrFailed: evidence.ocrFailed };
    }
    if (evidence.factsCandidates.length === 0) {
      state.recordImage(task.productId, "review", { evidenceFile }, {
        reasons: ["no_facts_signal"],
        ...(evidence.failures.length ? { failures: evidence.failures } : {}),
      });
      return { productId: task.productId, status: "review", factsCandidates: 0, ocrFailed: evidence.ocrFailed };
    }
    state.recordImage(task.productId, "ready", {
      source: "ocr_facts_candidates",
      evidenceFile,
      totalImages: evidence.totalImages,
      factsCandidates: evidence.factsCandidates.length,
      ocrFailed: evidence.ocrFailed,
    });
    return { productId: task.productId, status: "ready", factsCandidates: evidence.factsCandidates.length, ocrFailed: evidence.ocrFailed };
  });

  const report = {
    mode: "image_evidence_dry_run_only",
    sourceSnapshot: snapshotFile,
    snapshotProductCount: Number(snapshotMeta.product_count),
    generatedAt: new Date().toISOString(),
    claimed: claimed.length,
    ready: laneResults.filter((item) => item.status === "ready").length,
    review: laneResults.filter((item) => item.status === "review").length,
    failed: laneResults.filter((item) => item.status === "failed").length,
    results: laneResults,
    state: state.summary(),
  };
  await fs.mkdir(cli.outputDirectory, { recursive: true });
  const reportFile = path.join(cli.outputDirectory, `image-lane-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await fs.rm(cacheDirectory, { recursive: true, force: true });
  console.log(JSON.stringify({ ...report, results: undefined, reportFile }, null, 2));
} finally {
  state.close();
  snapshot.close();
}
