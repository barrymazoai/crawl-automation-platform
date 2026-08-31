import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProcessRunner } from "@crawl-automation/runtime";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AmazonImageEvidence } from "../src/amazon/backfill-image.js";
import { buildAmazonFormulaPrompt, buildAmazonFormulaProposal } from "../src/amazon/backfill-formula.js";
import { AmazonBackfillState } from "../src/amazon/backfill-state.js";
import { extractLabelJsonWithRepair, type StoredRawLabelVerdict } from "../src/amazon/label-extraction.js";
import { mapWithConcurrency } from "../src/amazon/ocr-label-pipeline.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(12),
  concurrency: z.coerce.number().int().min(1).max(10).default(2),
  imageReport: z.string().min(1).optional(),
  outputDirectory: z.string().min(1),
  stateFile: z.string().min(1),
}).parse({
  limit: flag("--limit") ?? 12,
  concurrency: flag("--concurrency") ?? 2,
  imageReport: flag("--image-report"),
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", "amazon-backfill-dry-run", "formula-evidence"),
  stateFile: flag("--state") ?? path.resolve("reports", "amazon-backfill-dry-run", "state.sqlite"),
});

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(backendDirectory, "../..");
delete process.env.CODEX_API_KEY;
const codex = new CodexProcessRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: false,
});

await fs.mkdir(cli.outputDirectory, { recursive: true });
const state = new AmazonBackfillState(cli.stateFile);
state.recoverInterrupted("formula");
const claimed = state.claimFormula(cli.limit);
const needsExistingOcr = claimed.filter((item) => item.source === "existing_ocr_text" && !item.evidenceFile).map((item) => item.productId);
let snapshot: DatabaseSync | null = null;
const existingOcrByProduct = new Map<string, AmazonImageEvidence["factsCandidates"]>();
if (needsExistingOcr.length > 0) {
  const snapshotFile = path.resolve(process.env.BACKFILL_SOURCE_SNAPSHOT ?? path.join(path.dirname(cli.stateFile), "source-evidence.sqlite"));
  snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
  const complete = snapshot.prepare("select value from snapshot_meta where key='complete'").get() as { value?: string } | undefined;
  if (complete?.value !== "true") throw new Error(`源证据快照不完整：${snapshotFile}`);
  const rows = snapshot.prepare(`select id,product_id,image_url,image_index,ocr_text from source_image
    where product_id in (${needsExistingOcr.map(() => "?").join(",")}) and ocr_text is not null and trim(ocr_text)<>''
    order by product_id,image_index,id`).all(...needsExistingOcr) as unknown as Array<{
    id: string; product_id: string; image_url: string; image_index: string; ocr_text: string;
  }>;
  for (const row of rows) {
    const candidates = existingOcrByProduct.get(row.product_id) ?? [];
    candidates.push({ imageId: row.id, imageUrl: row.image_url, imageIndex: Number(row.image_index), response: { text: row.ocr_text } });
    existingOcrByProduct.set(row.product_id, candidates);
  }
}
try {
  const results = await mapWithConcurrency(claimed, cli.concurrency, async (task) => {
    const productId = task.productId;
    const productDirectory = path.join(cli.outputDirectory, productId);
    const verdictFile = path.join(productDirectory, "label.raw.json");
    const proposalFile = path.join(productDirectory, "formula-proposal.json");
    await fs.mkdir(productDirectory, { recursive: true });
    try {
      const cached = JSON.parse(await fs.readFile(proposalFile, "utf8")) as ReturnType<typeof buildAmazonFormulaProposal>;
      state.recordFormula(productId, cached.status, cached, cached.reviewReasons.length ? { reasons: cached.reviewReasons } : undefined);
      return { ...cached, rows: cached.rows.length, proposalFile, cached: true };
    } catch {}
    let evidence: AmazonImageEvidence;
    if (task.evidenceFile) {
      evidence = JSON.parse(await fs.readFile(task.evidenceFile, "utf8")) as AmazonImageEvidence;
    } else {
      const factsCandidates = existingOcrByProduct.get(productId) ?? [];
      if (factsCandidates.length === 0) {
        const reviewReasons = ["existing_ocr_text_missing"];
        state.recordFormula(productId, "review", null, { reasons: reviewReasons });
        return { productId, status: "review" as const, reviewReasons, rows: 0 };
      }
      evidence = { productId, totalImages: factsCandidates.length, ocrSucceeded: factsCandidates.length, ocrFailed: 0, factsCandidates, failures: [] };
      await fs.writeFile(path.join(productDirectory, "existing-ocr-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    let stored: StoredRawLabelVerdict | null = null;
    try { stored = JSON.parse(await fs.readFile(verdictFile, "utf8")) as StoredRawLabelVerdict; } catch {}
    let call = 0;
    const verdict = await extractLabelJsonWithRepair({
      prompt: buildAmazonFormulaPrompt(evidence),
      tag: `amazon-formula-${productId}`,
      stored,
      runModel: async ({ prompt, tag }) => {
        call += 1;
        const result = await codex.run({
          prompt,
          cwd: repositoryDirectory,
          addDirectories: [productDirectory],
          schemaPath: path.join(backendDirectory, "model-payload.schema.json"),
          outputPath: path.join(productDirectory, `${String(call).padStart(2, "0")}-${tag}.result.json`),
          eventLogPath: path.join(productDirectory, `${String(call).padStart(2, "0")}-${tag}.events.jsonl`),
          signal: AbortSignal.timeout(Number(process.env.BACKFILL_MODEL_TIMEOUT_MS ?? 1_800_000)),
        });
        if (!result || typeof result !== "object" || !("payload" in result) || typeof result.payload !== "string") {
          throw new Error(`${tag}: Codex 输出缺少 payload`);
        }
        return result.payload;
      },
    });
    await fs.writeFile(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`);
    const proposal = buildAmazonFormulaProposal(evidence, verdict);
    await fs.writeFile(proposalFile, `${JSON.stringify(proposal, null, 2)}\n`);
    state.recordFormula(productId, proposal.status, proposal, proposal.reviewReasons.length ? { reasons: proposal.reviewReasons } : undefined);
    return { ...proposal, rows: proposal.rows.length, proposalFile };
  });

  const report = {
    mode: "formula_semantic_dry_run_only",
    modelInput: "facts_candidate_ocr_text_only",
    originalImagesSent: false,
    databaseWrites: false,
    generatedAt: new Date().toISOString(),
    requested: cli.limit,
    claimed: claimed.length,
    processed: results.length,
    ready: results.filter((item) => item.status === "ready").length,
    review: results.filter((item) => item.status === "review").length,
    formulaState: state.formulaSummary(),
    reviewQueueCount: state.listReviewQueue().length,
    results,
  };
  const reportFile = path.join(cli.outputDirectory, `formula-lane-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(cli.outputDirectory, "needs-review.json"), `${JSON.stringify({ generatedAt: report.generatedAt, items: state.listReviewQueue() }, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, results: undefined, reportFile }, null, 2));
} finally {
  state.close();
  snapshot?.close();
}
