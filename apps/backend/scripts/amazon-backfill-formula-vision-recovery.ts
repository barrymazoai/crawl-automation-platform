import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProcessRunner } from "@crawl-automation/runtime";
import { z } from "zod";
import {
  createR2ImageUrlResolver,
  downloadAmazonBackfillImage,
  type AmazonImageEvidence,
} from "../src/amazon/backfill-image.js";
import { buildAmazonFormulaProposal } from "../src/amazon/backfill-formula.js";
import { AmazonBackfillState } from "../src/amazon/backfill-state.js";
import { extractLabelJsonWithRepair, LABEL_EXTRACTION_PROMPT } from "../src/amazon/label-extraction.js";
import { formatOcrImage, mapWithConcurrency } from "../src/amazon/ocr-label-pipeline.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  concurrency: z.coerce.number().int().min(1).max(10).default(2),
  imageConcurrency: z.coerce.number().int().min(1).max(5).default(3),
  outputDirectory: z.string().min(1),
  stateFile: z.string().min(1),
}).parse({
  limit: flag("--limit") ?? 100,
  concurrency: flag("--concurrency") ?? 2,
  imageConcurrency: flag("--image-concurrency") ?? 3,
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", "amazon-formula-vision-recovery"),
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
const resolveImageUrl = createR2ImageUrlResolver();

function buildVisionPrompt(
  evidence: AmazonImageEvidence,
  images: Array<{ imageIndex: number; filename: string }>,
) {
  const localByIndex = new Map(images.map((image) => [image.imageIndex, image.filename]));
  const ocr = evidence.factsCandidates
    .filter((candidate) => localByIndex.has(candidate.imageIndex))
    .map((candidate) => formatOcrImage({
      index: candidate.imageIndex,
      fileName: localByIndex.get(candidate.imageIndex) as string,
      response: candidate.response,
    }))
    .join("\n\n");
  const paths = images.map((image) => `- 原始零基 imageIndex=${image.imageIndex}: ${image.filename}`).join("\n");
  return `这是固定的 Amazon Formula 图片恢复步骤，不是爬虫任务。清单中的图片已作为当前 Codex turn 的真实图片附件传入。
禁止读取或使用任何 Skill；禁止启动 sub-agent；禁止浏览器、网络搜索和 OCR 服务。
你必须逐一直接阅读每一个图片附件。OCR 文字只作定位辅助，图片是最终证据；不得只根据 OCR 文字作答。
factsImages 必须填写清单里的原始零基 imageIndex，不能按清单顺序重新编号。

本地图片清单：
${paths}

${LABEL_EXTRACTION_PROMPT}

OCR 辅助文字：
${ocr}

Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
}

await fs.mkdir(cli.outputDirectory, { recursive: true });
const state = new AmazonBackfillState(cli.stateFile);
const interrupted = state.recoverInterruptedFormulaRecovery();
const seeded = state.seedFormulaRecovery(cli.limit);
const claimed = state.claimFormulaRecovery(cli.limit);

try {
  const results = await mapWithConcurrency(claimed, cli.concurrency, async (task) => {
    const productDirectory = path.join(cli.outputDirectory, task.productId);
    const inputDirectory = path.join(productDirectory, "input-images");
    await fs.mkdir(inputDirectory, { recursive: true });
    try {
      const evidence = JSON.parse(await fs.readFile(task.evidenceFile, "utf8")) as AmazonImageEvidence;
      const downloads = await mapWithConcurrency(evidence.factsCandidates, cli.imageConcurrency, async (candidate) => {
        try {
          const resolvedUrl = await resolveImageUrl(candidate.imageUrl);
          const downloaded = await downloadAmazonBackfillImage({
            imageUrl: resolvedUrl,
            cacheKey: candidate.imageUrl,
            cacheDirectory: inputDirectory,
            fetchImpl: fetch,
          });
          const named = path.join(inputDirectory, `${String(candidate.imageIndex).padStart(2, "0")}${path.extname(downloaded)}`);
          await fs.rename(downloaded, named);
          return { ok: true as const, imageIndex: candidate.imageIndex, filename: named };
        } catch (error) {
          return {
            ok: false as const,
            imageIndex: candidate.imageIndex,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      });
      const images = downloads.filter((item) => item.ok).map((item) => ({
        imageIndex: item.imageIndex,
        filename: item.filename,
      }));
      await fs.writeFile(path.join(productDirectory, "input-manifest.json"), `${JSON.stringify({
        productId: task.productId,
        evidenceFile: task.evidenceFile,
        candidateCount: evidence.factsCandidates.length,
        downloads: downloads.map((item) => item.ok
          ? { imageIndex: item.imageIndex, localFile: path.basename(item.filename) }
          : item),
      }, null, 2)}\n`);
      if (images.length === 0) {
        const reasons = ["vision_candidate_images_unavailable"];
        state.recordFormulaRecovery(task.productId, "review", { downloads }, { reasons });
        return { productId: task.productId, status: "review" as const, reasons, downloaded: 0 };
      }

      let call = 0;
      const verdict = await extractLabelJsonWithRepair({
        prompt: buildVisionPrompt(evidence, images),
        tag: `amazon-formula-vision-${task.productId}`,
        runModel: async ({ prompt, tag }) => {
          call += 1;
          const result = await codex.run({
            prompt,
            cwd: repositoryDirectory,
            addDirectories: [productDirectory],
            imagePaths: images.map((image) => image.filename),
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
      await fs.writeFile(path.join(productDirectory, "vision-label.raw.json"), `${JSON.stringify(verdict, null, 2)}\n`);
      const availableIndexes = new Set(images.map((image) => image.imageIndex));
      const availableEvidence: AmazonImageEvidence = {
        ...evidence,
        factsCandidates: evidence.factsCandidates.filter((candidate) => availableIndexes.has(candidate.imageIndex)),
      };
      const proposal = buildAmazonFormulaProposal(availableEvidence, verdict);
      await fs.writeFile(path.join(productDirectory, "vision-formula-proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`);
      if (proposal.status === "ready") {
        const accepted = state.acceptFormulaRecovery(task.productId, proposal, {
          proposal,
          evidenceFile: task.evidenceFile,
          downloadedImages: images.map((image) => image.imageIndex),
        });
        return {
          productId: task.productId,
          status: "ready" as const,
          rows: proposal.rows.length,
          stagingRetried: accepted.stagingRetried,
          downloaded: images.length,
        };
      }
      state.recordFormulaRecovery(task.productId, "review", proposal, { reasons: proposal.reviewReasons });
      return {
        productId: task.productId,
        status: "review" as const,
        reasons: proposal.reviewReasons,
        rows: proposal.rows.length,
        downloaded: images.length,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.recordFormulaRecovery(task.productId, "failed", null, { reasons: [reason] });
      return { productId: task.productId, status: "failed" as const, reasons: [reason], downloaded: 0 };
    } finally {
      await fs.rm(inputDirectory, { recursive: true, force: true });
    }
  });

  const report = {
    mode: "formula_vision_recovery",
    modelInput: "selected_facts_candidate_images_plus_ocr_support",
    skillUsed: false,
    browserUsed: false,
    productRestoreWrites: false,
    generatedAt: new Date().toISOString(),
    requested: cli.limit,
    interruptedRecovered: interrupted,
    seeded: seeded.length,
    claimed: claimed.length,
    ready: results.filter((item) => item.status === "ready").length,
    review: results.filter((item) => item.status === "review").length,
    failed: results.filter((item) => item.status === "failed").length,
    stagingRetries: results.filter((item) => item.status === "ready" && item.stagingRetried).length,
    formulaRecoveryState: state.formulaRecoverySummary(),
    results,
  };
  const reportFile = path.join(cli.outputDirectory, `formula-vision-recovery-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, results: undefined, reportFile }, null, 2));
} finally {
  state.close();
}
