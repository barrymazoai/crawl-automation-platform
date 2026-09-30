/**
 * 收尾 Pool 入口：catalog_finalize -> ingest_staging -> cleanup_run。
 * 整个仓库里只有这个进程会调用 Product Server 的入库接口，
 * 也就是说下架判定（completeCrawlRun）只可能从这里发生，每个 run 一次。
 */
import { runCatalogFinalizeStage, runIngestStagingStage, preserveQuarantineEvidence } from "../v2/stages.js";
import { NoCompanyStore } from "../v2/no-company-store.js";
import { buildStageContext, channelRegistry, hooksFor } from "./shared/channels.js";
import { createCodex } from "./shared/codex.js";
import { createProductDeps } from "./shared/deps.js";
import { baseEnv, codexEnv, loadEnv, productEnv, stageEnv } from "./shared/env.js";
import { startWorker, type JobContext, type JobResult } from "./shared/run.js";

const env = loadEnv(baseEnv, codexEnv, productEnv, stageEnv);
const deps = createProductDeps(env);
const codex = createCodex(env);
const registry = channelRegistry({ pdfRenderScript: env.GNC_PDF_RENDER_SCRIPT });
// 品牌映射不到公司的产品不进产品库，完整写进这个本地 SQLite（09-04 决定），等整轮跑完再整理。
const noCompanyStore = new NoCompanyStore(env.NO_COMPANY_DB);
console.log(JSON.stringify({ type: "no_company_store_ready", file: env.NO_COMPANY_DB, existing: noCompanyStore.count() }));

/** 清理前先把隔离产品的证据转存到 REVIEW_ROOT 长期保留，再删 run 目录与远程产物。 */
async function cleanupRun(context: JobContext, preserved: { preserved: number }) {
  const { artifacts } = await context.client.runArtifacts(context.job.runId);
  for (const artifact of artifacts) await context.client.deleteArtifact(artifact.id, context.job.id, context.leaseToken);
  const { rm } = await import("node:fs/promises");
  const path = await import("node:path");
  await rm(path.resolve(env.WORK_ROOT, context.job.runId), { recursive: true, force: true });
  return { deletedArtifacts: artifacts.length, deletedLocalRun: true, ...preserved };
}

await startWorker({
  role: "finalize",
  capabilities: ["catalog_finalize", "ingest_staging", "cleanup_run"],
  env,
  handle: async (context): Promise<JobResult> => {
    const { job, jobDirectory, signal } = context;
    const hooks = hooksFor(registry, job.source.adapter);
    const stageContext = buildStageContext({
      deps, workRoot: env.WORK_ROOT, runId: job.runId, sourceUrl: job.source.url, signal,
      ocrConcurrency: env.OCR_IMAGE_CONCURRENCY,
      forcePartialScope: env.FORCE_PARTIAL_SCOPE === "true",
      runModel: ({ prompt, tag }) => codex.runModelPayload(jobDirectory, prompt, tag, signal),
      noCompanyStore,
    });
    if (job.stage === "catalog_finalize") return runCatalogFinalizeStage(hooks, stageContext, job.payload);
    if (job.stage === "ingest_staging") {
      const result = await runIngestStagingStage(hooks, stageContext);
      return result.status === "needs_review"
        ? { review: { reasonCode: result.reasonCode, summary: result.summary } }
        : result;
    }
    return cleanupRun(context, await preserveQuarantineEvidence(stageContext, env.REVIEW_ROOT));
  },
  shutdown: async () => { noCompanyStore.close(); await deps.close(); },
});
