/**
 * 图片 / OCR Pool 入口。
 * 只处理文字路径覆盖不了的产品（PDF 文本 -> OCR -> 视觉补救阶梯）。
 * job 级并发允许多个 Batch 交错（一个在 OCR 时另一个在下载图片），
 * 实际 OCR 并发由 OCR_IMAGE_CONCURRENCY 在阶段内部兜底。
 */
import { runProcessImagesStage } from "../v2/stages.js";
import { buildStageContext, channelRegistry, hooksFor } from "./shared/channels.js";
import { createCodex } from "./shared/codex.js";
import { createProductDeps } from "./shared/deps.js";
import { baseEnv, codexEnv, loadEnv, productEnv, stageEnv } from "./shared/env.js";
import { startWorker } from "./shared/run.js";

const env = loadEnv(baseEnv, codexEnv, productEnv, stageEnv);
const deps = createProductDeps(env);
const codex = createCodex(env);
const registry = channelRegistry({ pdfRenderScript: env.GNC_PDF_RENDER_SCRIPT });

await startWorker({
  role: "image",
  capabilities: ["process_images"],
  env,
  handle: async ({ job, jobDirectory, signal }) => runProcessImagesStage(
    hooksFor(registry, job.source.adapter),
    buildStageContext({
      deps, workRoot: env.WORK_ROOT, runId: job.runId, sourceUrl: job.source.url, signal,
      ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
      forcePartialScope: env.FORCE_PARTIAL_SCOPE === "true",
      runModel: ({ prompt, tag }) => codex.runModelPayload(jobDirectory, prompt, tag, signal),
    }),
    job.payload,
  ),
  shutdown: deps.close,
});
