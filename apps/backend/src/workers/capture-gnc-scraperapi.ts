/**
 * GNC 抓取入口（ScraperAPI 版）——不带浏览器、不带出口轮动。
 *
 * GNC 的 PerimeterX 把自建代理彻底堵死（干净住宅 IP 首访能过，同 IP 一频繁就降级，
 * 而代理 7 天只能换一次 IP，数学上跑不完全站）。这个入口把过 PX 外包给 ScraperAPI：
 * 它有海量住宅 IP 池 + 过 PX 能力，我们只管解析。
 *
 * 与 capture-gnc.ts 的关系：那个走浏览器+Clash 出口轮动，是历史方案；这个走 HTTP
 * API，无浏览器、无 Chrome profile、无代理，能多开。两者不要同时跑同一批任务。
 */
import { DiskGuard } from "../v2/disk-guard.js";
import { captureGncBrandCatalog } from "../gnc/brand-catalog.js";
import { createScraperApiHolder } from "../gnc/scraperapi-page.js";
import { loadRecentGncSkus } from "../gnc/recent-skus.js";
import { createScraperApiCreditGuard } from "../gnc/scraperapi-credits.js";
import { runGncCaptureCatalog } from "../v2/gnc-capture.js";
import { baseEnv, captureEnv, loadEnv, productEnv } from "./shared/env.js";
import { startWorker, type JobContext, type JobResult } from "./shared/run.js";
import { diskTelemetry } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, captureEnv, productEnv);
if (!env.SCRAPERAPI_KEY) throw new Error("capture-gnc-scraperapi 需要 SCRAPERAPI_KEY");

const disk = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});

const holderFactory = () => createScraperApiHolder({
  apiKey: env.SCRAPERAPI_KEY!,
  countryCode: env.SCRAPERAPI_COUNTRY,
  log: (event) => console.log(JSON.stringify(event)),
});

const credits = createScraperApiCreditGuard({
  apiKey: env.SCRAPERAPI_KEY!,
  minCredits: env.SCRAPERAPI_MIN_CREDITS,
  log: (event) => console.log(JSON.stringify(event)),
});

await startWorker({
  role: "capture-gnc-scraperapi",
  capabilities: ["gnc"],
  sourceAdapters: ["gnc"],
  env,
  canClaim: async () => (await disk.allowNewCatalog()) && (await credits.allow()),
  telemetry: async () => {
    const diskState = await diskTelemetry(disk, env.DISK_SOFT_MIN_FREE_GB, env.DISK_HARD_MIN_FREE_GB);
    return diskState ? { disk: diskState } : {};
  },
  // 任何异常都转成复核项而不是抛出：公共层会把抛出的错误标成 retryable 重排 6 次，
  // 每次重领都再烧一遍 ScraperAPI 额度。失败就躺在复核队列里，一轮测完人工看。
  handle: async (context) => {
    try {
      return await handleJob(context);
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ type: "gnc_scraperapi_job_failed", jobId: context.job.id, stage: context.job.stage, message: message.slice(0, 300) }));
      return { review: { reasonCode: "gnc_scraperapi_failed", summary: `${context.job.source.url}: ${message.slice(0, 500)}` } };
    }
  },
});

async function handleJob({ job, leaseToken, signal, client }: JobContext): Promise<JobResult> {
  // 品牌目录刷新：ScraperAPI 拉一次 /brands，就地抠品牌链接。
  if (job.stage === "resolve_brand_catalog") {
    const holder = holderFactory();
    const catalog = await captureGncBrandCatalog({ url: job.source.url, signal, holderFactory });
    console.log(JSON.stringify({ type: "gnc_brand_catalog_captured", entries: catalog.entries.length, expected: catalog.expectedCount, complete: catalog.complete }));
    await holder.close();
    if (!catalog.entries.length) {
      return { review: { reasonCode: "gnc_brand_catalog_empty", summary: `${job.source.url} 没有解析出任何品牌链接` } };
    }
    return { channel: "gnc", ...catalog };
  }

  // 每个 job 开始时取一次库里最近见过的 SKU：同一 SKU 不再花额度重抓
  const recent = await loadRecentGncSkus(env.PRODUCT_DATABASE_URL, env.GNC_SKIP_SEEN_DAYS);
  console.log(JSON.stringify({ type: "gnc_recent_skus_loaded", count: recent.size, withinDays: env.GNC_SKIP_SEEN_DAYS }));
  const result = await runGncCaptureCatalog({
    url: job.source.url,
    holderFactory,
    shouldSkip: (sku) => recent.has(sku),
    runId: job.runId,
    workRoot: env.WORK_ROOT,
    maxItems: env.GNC_MAX_ITEMS,
    batchSize: env.V2_CAPTURE_BATCH_SIZE,
    productDelayMs: env.CAPTURE_PRODUCT_DELAY_MS,
    signal,
    registerBatch: (batch) => client.registerCaptureBatch(job.id, leaseToken, batch),
    finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, leaseToken, catalog),
    beforePublish: () => disk.waitForPublishAllowance(signal),
  });
  return result.status === "needs_review"
    ? { review: { reasonCode: result.reasonCode, summary: result.summary } }
    : result;
}
