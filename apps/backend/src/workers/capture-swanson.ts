/**
 * Swanson 抓取入口。
 *
 * 全程走浏览器：商品页带 302 重定向与 Cookie 校验，成分表在页面内嵌 JSON 里，
 * 用 HTTP 取要自己处理跳转、UA、TLS 指纹，而且实测 43 个商品就触发了
 * Cloudflare 的 429。浏览器天然对这些免疫。
 *
 * 出口按批轮动：Swanson 不像 GNC 那样需要为每个出口维护独立 Chrome profile，
 * 换出口只是调一次 Clash 的选择器接口，代价接近零，所以可以换得更勤。
 */
import fs from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { startChromeLane } from "@crawl-automation/runtime";
import { ClashControllerSelector } from "../sales-channel-egress/clash-controller.js";
import { SwansonEgressRotation } from "../swanson/egress.js";
import { DiskGuard } from "../v2/disk-guard.js";
import { runSwansonCaptureCatalog } from "../v2/swanson-capture.js";
import { baseEnv, captureEnv, egressEnv, loadEnv } from "./shared/env.js";
import { startWorker } from "./shared/run.js";
import { diskTelemetry } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, captureEnv, egressEnv);
if (env.NODE_MAX_CONCURRENCY !== 1) throw new Error("swanson_capture_requires_single_slot：Chrome profile 与出口选择是单例");

const clashConfig = z.object({ secret: z.union([z.string(), z.number()]).optional() }).passthrough()
  .parse(parseYaml(await fs.readFile(env.SALES_CHANNEL_CLASH_CONFIG_FILE, "utf8")));
const clashSelector = new ClashControllerSelector({
  baseUrl: env.SALES_CHANNEL_CLASH_CONTROLLER_URL,
  secret: clashConfig.secret?.toString() ?? "",
});

/** 出口清单从 Clash 的选择组实时读取，不在 .env 里再抄一份，免得两处不一致。 */
const exits = await clashSelector.listMembers(env.SWANSON_EGRESS_SELECTOR);
console.log(JSON.stringify({ type: "swanson_egress_exits", group: env.SWANSON_EGRESS_SELECTOR, count: exits.length }));
const rotation = new SwansonEgressRotation({
  selector: clashSelector,
  group: env.SWANSON_EGRESS_SELECTOR,
  exits,
  batchSize: env.SWANSON_EGRESS_BATCH_SIZE,
  log: (event) => console.log(JSON.stringify(event)),
});

const disk = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});

const browser = await startChromeLane({ id: 2, profileRoot: `${env.SALES_CHANNEL_EGRESS_PROFILE_ROOT}/swanson`, headless: false });
process.env.CHROME_CDP_URL = browser.cdpUrl;

await startWorker({
  role: "capture-swanson",
  capabilities: ["swanson"],
  sourceAdapters: ["swanson"],
  env,
  canClaim: () => disk.allowNewCatalog(),
  telemetry: async () => {
    const diskState = await diskTelemetry(disk, env.DISK_SOFT_MIN_FREE_GB, env.DISK_HARD_MIN_FREE_GB);
    return {
      ...(diskState ? { disk: diskState } : {}),
      egress: {
        channel: "swanson",
        exitId: rotation.current,
        ip: null,
        exits: [...exits],
        updatedAt: new Date().toISOString(),
      },
    };
  },
  handle: async ({ job, leaseToken, signal, client }) => {
    await rotation.prepare();
    const result = await runSwansonCaptureCatalog({
      url: job.source.url,
      runId: job.runId,
      workRoot: env.WORK_ROOT,
      maxItems: env.SWANSON_MAX_ITEMS,
      batchSize: env.V2_CAPTURE_BATCH_SIZE,
      throttle: { concurrency: env.SWANSON_CONCURRENCY, delayMs: env.SWANSON_REQUEST_DELAY_MS },
      onProduct: () => rotation.recordProduct().then(() => undefined),
      signal,
      registerBatch: (batch) => client.registerCaptureBatch(job.id, leaseToken, batch),
      finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, leaseToken, catalog),
      beforePublish: () => disk.waitForPublishAllowance(signal),
    });
    return result.status === "needs_review"
      ? { review: { reasonCode: result.reasonCode, summary: result.summary } }
      : result;
  },
  shutdown: async () => {
    await browser.close?.().catch(() => {});
    await clashSelector.close();
  },
});
