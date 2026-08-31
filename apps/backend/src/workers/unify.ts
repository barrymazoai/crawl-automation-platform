/**
 * 整合 Pool 入口：product_join（合并文字线与图片线）+ product_unify（统一名称与变体）。
 * 图片线不存在的 Batch，join 不会空等。
 */
import { runProductJoinStage, runProductUnifyStage } from "../v2/stages.js";
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
  role: "unify",
  capabilities: ["product_join", "product_unify"],
  env,
  handle: async ({ job, jobDirectory, signal }) => {
    const hooks = hooksFor(registry, job.source.adapter);
    const context = buildStageContext({
      deps, workRoot: env.WORK_ROOT, runId: job.runId, sourceUrl: job.source.url, signal,
      ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
      forcePartialScope: env.FORCE_PARTIAL_SCOPE === "true",
      runModel: ({ prompt, tag }) => codex.runModelPayload(jobDirectory, prompt, tag, signal),
    });
    return job.stage === "product_join"
      ? runProductJoinStage(hooks, context, job.payload)
      : runProductUnifyStage(hooks, context, job.payload);
  },
  shutdown: deps.close,
});
