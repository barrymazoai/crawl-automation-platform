import fs from "node:fs/promises";
import path from "node:path";
import type { CapturedProductV1 } from "@crawl-automation/contracts";
import { writeJsonAtomic } from "@crawl-automation/runtime";
import { captureProducts, discoverInitialAsins, type CapturedProduct } from "../amazon/pipeline.js";
import { BatchPublisher } from "./batch-publisher.js";
import { runRoot } from "./paths.js";

/** v2 存储的 Amazon 原始证据 = v1 的 CapturedProduct + 来源 origin（下游拼 productUrl 用）。 */
export type AmazonRawProduct = CapturedProduct & { sourceOrigin: string };

export interface AmazonCaptureCatalogOptions {
  url: string;
  runId: string;
  workRoot: string;
  maxItems: number;
  batchSize: number;
  signal: AbortSignal;
  registerBatch: (batch: { batchId: string; ordinal: number; itemCount: number; batchDirectory: string; imagesRequired: boolean }) => Promise<unknown>;
  /** 可选：每次 Batch 发布前调用（磁盘硬阈值背压等待）。 */
  beforePublish?: (() => Promise<void>) | undefined;
  finalizeCatalog: (catalog: { inputKind: "brand_catalog" | "product" | "search"; exhausted: boolean; truncated: boolean; expectedCount: number | null; discoveredCount: number; processedCount: number }) => Promise<unknown>;
}

export type AmazonCaptureCatalogResult =
  | { status: "complete"; itemCount: number; batchCount: number; discoveredCount: number; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number; batchCount: number };

/** 抓取产物 -> 统一契约。Amazon 私有字段（family、aplusText 等）保留在 products/<asin>.json 原始证据里。 */
export function toAmazonCapturedProduct(product: AmazonRawProduct): CapturedProductV1 {
  const extracted = product.extracted;
  return {
    externalId: product.asin,
    sku: null,
    productUrl: `${product.sourceOrigin}/dp/${product.asin}`,
    brandRaw: extracted.brand,
    titleRaw: extracted.title ?? product.asin,
    price: extracted.price,
    currency: extracted.currency,
    availability: extracted.inStock == null ? null : extracted.inStock ? "in_stock" : "out_of_stock",
    rating: extracted.rating,
    reviewCount: extracted.reviewCount == null ? null : Math.trunc(extracted.reviewCount),
    unitsSoldText: extracted.unitsSold != null
      ? `${extracted.unitsSold}+ bought in past ${extracted.unitsSoldPeriod ?? "period"}`
      : null,
    rawVariantAttrs: {
      ...(extracted.itemForm ? { itemForm: extracted.itemForm } : {}),
      ...(extracted.unitCount ? { unitCount: extracted.unitCount } : {}),
      ...(product.familyLabel ? { familyLabel: product.familyLabel } : {}),
    },
    descriptionText: extracted.description,
    detailText: extracted.bullets,
    ingredientText: extracted.ingredientsText,
    factsEvidence: { htmlTable: null, pdfUrl: null, imageRefs: extracted.images },
    images: extracted.images,
    sourceFiles: [`products/${product.asin}.json`],
    captureCompleteness: "full",
    capturedAt: product.capturedAt,
  };
}

/** Amazon 没有 HTML Facts：只要 Batch 里有任何产品带图片，就需要图片线。 */
export function amazonBatchImagesRequired(products: readonly AmazonRawProduct[]) {
  return products.some((product) => product.extracted.images.length > 0);
}

/**
 * v2 capture_catalog（Amazon）：只负责 Brand Store/搜索发现、ASIN 变体家族展开和商品页抓取。
 * 每攒够 batchSize 立即发布一个 Batch——抓取线绝不等待处理线。不做 OCR、语义、Unify 或入库。
 */
export async function runAmazonCaptureCatalog(options: AmazonCaptureCatalogOptions): Promise<AmazonCaptureCatalogResult> {
  const root = runRoot(options.workRoot, options.runId);
  await fs.mkdir(root, { recursive: true });
  const discovery = await discoverInitialAsins(options.url, options.maxItems);
  await writeJsonAtomic(path.join(root, "capture", "discovery.json"), discovery);
  if (discovery.asins.length === 0) {
    return { status: "needs_review", reasonCode: "amazon_no_asin", summary: "Amazon 页面没有发现 ASIN", itemCount: 0, batchCount: 0 };
  }

  const sourceOrigin = new URL(options.url).origin;
  const publisher = new BatchPublisher<AmazonRawProduct>({
    channel: "amazon",
    adapter: "amazon",
    sourceType: "sales_channel",
    url: options.url,
    runId: options.runId,
    workRoot: options.workRoot,
    batchSize: options.batchSize,
    key: (product) => product.asin,
    toContract: toAmazonCapturedProduct,
    imagesRequired: amazonBatchImagesRequired,
    registerBatch: options.registerBatch,
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
  });
  await publisher.init();
  const capture = await captureProducts({
    url: options.url,
    jobDirectory: root,
    maxItems: options.maxItems,
    signal: options.signal,
    onProduct: (product) => publisher.add({ ...product, sourceOrigin }),
  }, discovery.asins);
  await publisher.flush();

  await writeJsonAtomic(path.join(root, "capture", "capture.json"), {
    queuedCount: capture.queuedCount,
    productCount: capture.products.length,
    truncated: capture.truncated,
    batchCount: publisher.batchCount,
  });
  await options.finalizeCatalog({
    inputKind: discovery.inputKind,
    exhausted: discovery.exhausted,
    truncated: discovery.truncated || capture.truncated,
    expectedCount: discovery.expectedCount,
    discoveredCount: capture.queuedCount,
    processedCount: capture.products.length,
  });
  return {
    status: "complete",
    itemCount: capture.products.length,
    batchCount: publisher.batchCount,
    discoveredCount: capture.queuedCount,
    summary: `Amazon 抓取完成：商品 ${capture.products.length}，Batch ${publisher.batchCount}，ASIN ${capture.products.length}/${capture.queuedCount}`,
  };
}
