import fs from "node:fs/promises";
import path from "node:path";
import { CapturedProductBatchV1Schema, type CapturedProductBatchV1, type CapturedProductV1 } from "@crawl-automation/contracts";
import { listReadyDirectories, publishReadyMarker, readReadyMarker, writeJsonAtomic } from "@crawl-automation/runtime";
import { batchDirectory, batchIdFor, READY, relativeBatchDirectory, runRoot } from "./paths.js";

export type BatchRegisterInput = { batchId: string; ordinal: number; itemCount: number; batchDirectory: string; imagesRequired: boolean; exit?: string };

export interface BatchPublisherConfig<TRaw> {
  channel: string;
  adapter: string | null;
  sourceType: "dtc_browser" | "sales_channel";
  url: string;
  runId: string;
  workRoot: string;
  batchSize: number;
  key(product: TRaw): string;
  toContract(product: TRaw): CapturedProductV1;
  imagesRequired(products: readonly TRaw[]): boolean;
  registerBatch(batch: BatchRegisterInput): Promise<unknown>;
  /** 可选：每次发布前调用（磁盘硬阈值背压在这里等待，方案 6）。 */
  beforePublish?(): Promise<void>;
  /** 可选：当前出口 id（IP 轮动渠道），标注进 Batch 注册请求供网页展示。 */
  currentExit?(): string | null;
}

/**
 * 通用 Capture Batch 发布器（channel 无关）：
 * - 每攒够 batchSize 立即原子发布（products/*.json + batch.json + capture.ready.json）并注册处理子 DAG；
 * - init() 支持重试恢复：接续 ordinal、跳过已发布产品、从标记逐字重放注册请求，
 *   覆盖"标记已发布但注册请求丢失"的半步崩溃窗口。
 */
export class BatchPublisher<TRaw> {
  private pending: TRaw[] = [];
  private published = 0;
  private seen = new Set<string>();
  constructor(private config: BatchPublisherConfig<TRaw>) {}

  get batchCount() { return this.published; }

  async init() {
    const captureRoot = path.join(runRoot(this.config.workRoot, this.config.runId), "capture");
    for (const directory of await listReadyDirectories(captureRoot, READY.capture)) {
      const marker = await readReadyMarker<BatchRegisterInput>(directory, READY.capture);
      if (!marker?.batchId) continue;
      const batch = JSON.parse(await fs.readFile(path.join(directory, "batch.json"), "utf8")) as CapturedProductBatchV1;
      for (const product of batch.products) if (product.externalId) this.seen.add(product.externalId);
      this.published = Math.max(this.published, marker.ordinal + 1);
      await this.config.registerBatch(marker);
    }
  }

  async add(product: TRaw) {
    const key = this.config.key(product);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.pending.push(product);
    if (this.pending.length >= this.config.batchSize) await this.flush();
  }

  async flush() {
    if (this.pending.length === 0) return;
    await this.config.beforePublish?.();
    const products = this.pending;
    this.pending = [];
    const ordinal = this.published;
    const batchId = batchIdFor(ordinal + 1);
    const directory = batchDirectory(this.config.workRoot, this.config.runId, "capture", batchId);
    for (const product of products) {
      await writeJsonAtomic(path.join(directory, "products", `${this.config.key(product)}.json`), product);
    }
    const batch: CapturedProductBatchV1 = CapturedProductBatchV1Schema.parse({
      schemaVersion: "1.0",
      sourceType: this.config.sourceType,
      channel: this.config.channel,
      adapter: this.config.adapter,
      runId: this.config.runId,
      batchId,
      ordinal,
      catalogKey: this.config.url,
      capturedAt: new Date().toISOString(),
      itemCount: products.length,
      products: products.map((product) => this.config.toContract(product)),
    } satisfies CapturedProductBatchV1);
    await writeJsonAtomic(path.join(directory, "batch.json"), batch);
    const exit = this.config.currentExit?.() ?? null;
    const register: BatchRegisterInput = {
      batchId,
      ordinal,
      itemCount: products.length,
      batchDirectory: relativeBatchDirectory(this.config.runId, batchId),
      imagesRequired: this.config.imagesRequired(products),
      ...(exit ? { exit } : {}),
    };
    // 标记内容即注册请求：先落标记再注册，重试时 init() 可从标记逐字重放注册。
    await publishReadyMarker(directory, READY.capture, register);
    await this.config.registerBatch(register);
    this.published += 1;
  }
}
