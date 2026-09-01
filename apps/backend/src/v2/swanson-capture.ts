import fs from "node:fs/promises";
import path from "node:path";
import type { CapturedProductV1 } from "@crawl-automation/contracts";
import { writeJsonAtomic } from "@crawl-automation/runtime";
import { captureProducts, discoverCatalog, stripHtml, type CapturedSwansonProduct, type SwansonThrottle } from "../swanson/pipeline.js";
import { createSwansonFetcher } from "../swanson/fetcher.js";
import { BatchPublisher } from "./batch-publisher.js";
import { runRoot } from "./paths.js";

export interface SwansonCaptureCatalogOptions {
  url: string;
  runId: string;
  workRoot: string;
  maxItems: number;
  throttle?: SwansonThrottle;
  /** 每抓一个商品调用一次，用于出口轮动。 */
  onProduct?: () => Promise<void> | void;
  batchSize: number;
  signal: AbortSignal;
  registerBatch: (batch: { batchId: string; ordinal: number; itemCount: number; batchDirectory: string; imagesRequired: boolean }) => Promise<unknown>;
  beforePublish?: (() => Promise<void>) | undefined;
  finalizeCatalog: (catalog: { inputKind: "brand_catalog" | "product" | "search"; exhausted: boolean; truncated: boolean; expectedCount: number | null; discoveredCount: number; processedCount: number }) => Promise<unknown>;
}

export type SwansonCaptureCatalogResult =
  | { status: "complete"; itemCount: number; batchCount: number; discoveredCount: number; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number; batchCount: number };

/** 抓取产物 -> 统一契约。Shopify/Constructor 原始数据保留在 products/<externalId>.json。 */
export function toSwansonCapturedProduct(product: CapturedSwansonProduct): CapturedProductV1 {
  const data = product.catalog.data;
  return {
    externalId: product.externalId,
    sku: product.sku,
    productUrl: product.productUrl,
    brandRaw: product.catalog.brand || product.product.vendor || null,
    titleRaw: product.product.title,
    price: product.variant.price != null ? String(Number(product.variant.price) / 100) : null,
    currency: "USD",
    availability: product.variant.available == null ? null : product.variant.available ? "in_stock" : "out_of_stock",
    rating: product.catalog.rating,
    reviewCount: product.catalog.reviewCount == null ? null : Math.trunc(product.catalog.reviewCount),
    unitsSoldText: null,
    rawVariantAttrs: {
      ...(product.variant.title ? { variantTitle: product.variant.title } : {}),
      ...(data.flavor ? { flavor: data.flavor } : {}),
      ...(data.potent ? { potency: data.potent } : {}),
      ...(data.count != null ? { count: String(data.count) } : {}),
    },
    descriptionText: stripHtml(product.product.description) || null,
    detailText: [data.main_ingred, data.potent, data.pfdesc].filter(Boolean).join("\n") || null,
    ingredientText: data.main_ingred ?? null,
    factsEvidence: { htmlTable: null, pdfUrl: null, imageRefs: product.images },
    images: product.images,
    sourceFiles: [`products/${product.externalId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`],
    captureCompleteness: "full",
    capturedAt: product.capturedAt,
  };
}

/** Swanson 没有 HTML 成分表：只要 Batch 里有带图片的产品，就需要图片线。 */
export function swansonBatchImagesRequired(products: readonly CapturedSwansonProduct[]) {
  return products.some((product) => product.images.length > 0);
}

/**
 * v2 capture_catalog（Swanson）：走 Constructor/Shopify 的 HTTP 接口抓取，**不需要浏览器**。
 * 每攒够 batchSize 立即发布一个 Batch，抓取线不等待处理线。
 */
export async function runSwansonCaptureCatalog(options: SwansonCaptureCatalogOptions): Promise<SwansonCaptureCatalogResult> {
  const root = runRoot(options.workRoot, options.runId);
  await fs.mkdir(root, { recursive: true });
  // 整轮共用一条浏览器通道：目录接口、商品 JSON、成分表都在页面上下文里取
  const fetcher = createSwansonFetcher();
  const captureOptions = {
    url: options.url, maxItems: options.maxItems, signal: options.signal,
    fetcher, throttle: options.throttle ?? { concurrency: 2, delayMs: 2000 },
    ...(options.onProduct ? { onProduct: options.onProduct } : {}),
  };
  try {
  const catalog = await discoverCatalog(captureOptions);
  await writeJsonAtomic(path.join(root, "capture", "discovery.json"), catalog);
  if (catalog.entries.length === 0) {
    return { status: "needs_review", reasonCode: "swanson_no_products", summary: "Swanson 页面没有发现商品", itemCount: 0, batchCount: 0 };
  }

  const publisher = new BatchPublisher<CapturedSwansonProduct>({
    channel: "swanson",
    adapter: "swanson",
    sourceType: "sales_channel",
    url: options.url,
    runId: options.runId,
    workRoot: options.workRoot,
    batchSize: options.batchSize,
    key: (product) => product.externalId.replace(/[^a-zA-Z0-9_-]/g, "_"),
    toContract: toSwansonCapturedProduct,
    imagesRequired: swansonBatchImagesRequired,
    registerBatch: options.registerBatch,
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
  });
  await publisher.init();

  // Swanson 一次性拿到整个目录的变体列表；按上限截断后分批发布。
  const products = (await captureProducts(captureOptions, catalog)).slice(0, options.maxItems);
  for (const product of products) await publisher.add(product);
  await publisher.flush();

  await writeJsonAtomic(path.join(root, "capture", "capture.json"), {
    productCount: products.length,
    entryCount: catalog.entries.length,
    truncated: catalog.truncated,
    batchCount: publisher.batchCount,
  });
  await options.finalizeCatalog({
    inputKind: catalog.inputKind,
    exhausted: catalog.exhausted,
    truncated: catalog.truncated || products.length >= options.maxItems,
    expectedCount: catalog.expectedCount,
    discoveredCount: products.length,
    processedCount: products.length,
  });
  return {
    status: "complete",
    itemCount: products.length,
    batchCount: publisher.batchCount,
    discoveredCount: products.length,
    summary: `Swanson 抓取完成：商品 ${products.length}，Batch ${publisher.batchCount}`,
  };
  } finally {
    // 通道可能持有浏览器，无论成败都要关掉
    await fetcher.close();
  }
}
