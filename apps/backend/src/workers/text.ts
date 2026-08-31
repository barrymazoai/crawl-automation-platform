/**
 * 文字 / 语义 Pool 入口。
 * 只做语义清洗与文字路径 Facts 提取——没有浏览器、没有代理轮动、不写产品库。
 */
import { runProcessTextStage } from "../v2/stages.js";
import { buildStageContext, channelRegistry, hooksFor } from "./shared/channels.js";
import { createCodex } from "./shared/codex.js";
import { createProductDeps } from "./shared/deps.js";
import { baseEnv, codexEnv, loadEnv, productEnv, stageEnv } from "./shared/env.js";
import { startWorker } from "./shared/run.js";
import { createCodexQuotaProbe } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, codexEnv, productEnv, stageEnv);
const deps = createProductDeps(env);
const codex = createCodex(env);
const registry = channelRegistry({ pdfRenderScript: env.GNC_PDF_RENDER_SCRIPT });
const codexQuota = createCodexQuotaProbe(env.CODEX_USAGE_COMMAND);

await startWorker({
  role: "text",
  capabilities: ["process_text"],
  env,
  telemetry: async () => {
    const codexUsage = await codexQuota();
    return codexUsage ? { codex: codexUsage } : {};
  },
  handle: async ({ job, jobDirectory, signal }) => runProcessTextStage(
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
