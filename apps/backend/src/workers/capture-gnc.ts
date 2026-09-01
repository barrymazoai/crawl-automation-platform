/**
 * GNC 抓取入口——全仓库唯一带 IP 轮动的进程。
 * 只做目录发现、分页、商品抓取和出口轮动；不做 OCR、语义、Unify 或入库。
 */
import fs from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { startChromeLane } from "@crawl-automation/runtime";
import { ClashControllerSelector } from "../sales-channel-egress/clash-controller.js";
import { SalesChannelEgressManager } from "../sales-channel-egress/manager.js";
import { SalesChannelEgressState } from "../sales-channel-egress/state.js";
import type { SalesChannelEgressPolicy } from "../sales-channel-egress/types.js";
import { DiskGuard } from "../v2/disk-guard.js";
import { captureGncBrandCatalog } from "../gnc/brand-catalog.js";
import { runGncCaptureCatalog } from "../v2/gnc-capture.js";
import { baseEnv, captureEnv, egressEnv, loadEnv, parseEgressExits } from "./shared/env.js";
import { startWorker } from "./shared/run.js";
import { createEgressIpProbe, diskTelemetry } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, captureEnv, egressEnv);
if (env.NODE_MAX_CONCURRENCY !== 1) throw new Error("gnc_capture_requires_single_slot：出口轮动与 Chrome profile 是单例");

const clashConfig = z.object({ secret: z.union([z.string(), z.number()]).optional() }).passthrough()
  .parse(parseYaml(await fs.readFile(env.SALES_CHANNEL_CLASH_CONFIG_FILE, "utf8")));
const clashSelector = new ClashControllerSelector({
  baseUrl: env.SALES_CHANNEL_CLASH_CONTROLLER_URL,
  secret: clashConfig.secret?.toString() ?? "",
});
const policy: SalesChannelEgressPolicy = {
  channel: "gnc",
  pool: env.GNC_EGRESS_POOL,
  selector: env.GNC_EGRESS_SELECTOR,
  exits: parseEgressExits(env.GNC_EGRESS_EXITS),
  batchSize: env.GNC_EGRESS_BATCH_SIZE,
  challengeCooldownMs: env.GNC_EGRESS_CHALLENGE_COOLDOWN_MS,
  networkFailureCooldownMs: env.GNC_EGRESS_NETWORK_FAILURE_COOLDOWN_MS,
  maxFailureRetries: env.GNC_EGRESS_MAX_FAILURE_RETRIES,
};
const egressState = new SalesChannelEgressState(env.SALES_CHANNEL_EGRESS_STATE_DB);
const egress = new SalesChannelEgressManager({
  state: egressState,
  policies: [policy],
  profileRoot: env.SALES_CHANNEL_EGRESS_PROFILE_ROOT,
  selectProxy: async ({ selector, proxyName }) => { await clashSelector.select(selector, proxyName); },
  startBrowser: async ({ profileRoot }) => startChromeLane({ id: 1, profileRoot, headless: false }),
  onBrowserReady: (browser) => { process.env.CHROME_CDP_URL = browser.cdpUrl; },
});
const disk = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});
const egressIp = createEgressIpProbe(env.SALES_CHANNEL_PROXY_URL);

await startWorker({
  role: "capture-gnc",
  capabilities: ["gnc"],
  sourceAdapters: ["gnc"],
  env,
  /**
   * 领任务前的两道闸门：
   * 1. 磁盘软阈值——吃紧时不领新品牌（当前品牌继续收尾）。
   * 2. 出口可用性——四个出口全部冷却（被挑战或断网）时不要领任务。
   *    没有这道闸门，一次 10 分钟的冷却会让 worker 把整个队列拉出来空转失败，
   *    十分钟的冷却赔掉上百个任务的重试预算（2026-08-31 实测：95 个任务在一分钟内失败）。
   */
  canClaim: async () => {
    if (!await disk.allowNewCatalog()) return false;
    if (!egress.hasAvailableExit("gnc")) {
      console.log(JSON.stringify({ type: "egress_all_cooling_pause_claim", channel: "gnc", nextAvailableAt: egress.nextAvailableAt("gnc") }));
      return false;
    }
    return true;
  },
  telemetry: async () => {
    const extras: Record<string, unknown> = {};
    const diskState = await diskTelemetry(disk, env.DISK_SOFT_MIN_FREE_GB, env.DISK_HARD_MIN_FREE_GB);
    if (diskState) extras.disk = diskState;
    const exit = egress.currentExit("gnc");
    if (exit) {
      extras.egress = {
        channel: "gnc",
        exitId: exit.exitId,
        ip: await egressIp(exit.exitId),
        exits: policy.exits.map((entry) => entry.id),
        updatedAt: new Date().toISOString(),
      };
    }
    return extras;
  },
  handle: async ({ job, leaseToken, signal, client }) => {
    const selection = await egress.prepare("gnc");
    console.log(JSON.stringify({ type: "sales_channel_egress_prepared", channel: "gnc", exitId: selection.exit.id, successCount: selection.successCount }));

    // 解析线的目录刷新：一次访问换回整页品牌，交给这个持有出口浏览器的池执行，
    // 不另开绕过风控的通道。抓不全就如实上报，由控制面丢弃，绝不拿半份目录去比对。
    if (job.stage === "resolve_brand_catalog") {
      const catalog = await captureGncBrandCatalog({ url: job.source.url, signal, rotation: egress.rotation("gnc") });
      console.log(JSON.stringify({ type: "gnc_brand_catalog_captured", entries: catalog.entries.length, expected: catalog.expectedCount, complete: catalog.complete }));
      if (!catalog.entries.length) {
        return { review: { reasonCode: "gnc_brand_catalog_empty", summary: `${job.source.url} 没有解析出任何品牌链接` } };
      }
      return { channel: "gnc", ...catalog };
    }

    const result = await runGncCaptureCatalog({
      url: job.source.url,
      runId: job.runId,
      workRoot: env.WORK_ROOT,
      maxItems: env.GNC_MAX_ITEMS,
      batchSize: env.V2_CAPTURE_BATCH_SIZE,
      productDelayMs: env.CAPTURE_PRODUCT_DELAY_MS,
      signal,
      rotation: egress.rotation("gnc"),
      registerBatch: (batch) => client.registerCaptureBatch(job.id, leaseToken, batch),
      finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, leaseToken, catalog),
      beforePublish: () => disk.waitForPublishAllowance(signal),
      currentExit: () => egress.currentExit("gnc")?.exitId ?? null,
    });
    return result.status === "needs_review"
      ? { review: { reasonCode: result.reasonCode, summary: result.summary } }
      : result;
  },
  shutdown: async () => {
    await egress.close();
    await clashSelector.close();
    egressState.close();
  },
});
