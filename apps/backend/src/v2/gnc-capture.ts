import fs from "node:fs/promises";
import path from "node:path";
import type { CapturedProductV1 } from "@crawl-automation/contracts";
import { writeJsonAtomic } from "@crawl-automation/runtime";
import { captureProducts, discoverProductUrls, GncAccessChallengeError, type GncDiscoveryResult } from "../gnc/capture.js";
import { hasCompleteFactsText } from "../gnc/facts.js";
import type { ExtractedGncProduct } from "../gnc/extract.js";
import type { SalesChannelNavigationRotation } from "../sales-channel-egress/types.js";
import { BatchPublisher } from "./batch-publisher.js";
import { runRoot } from "./paths.js";

export interface GncCaptureCatalogOptions {
  url: string;
  runId: string;
  workRoot: string;
  maxItems: number;
  batchSize: number;
  signal: AbortSignal;
  rotation?: SalesChannelNavigationRotation | undefined;
  registerBatch: (batch: { batchId: string; ordinal: number; itemCount: number; batchDirectory: string; imagesRequired: boolean }) => Promise<unknown>;
  /** 可选：每次 Batch 发布前调用（磁盘硬阈值背压等待）。 */
  beforePublish?: (() => Promise<void>) | undefined;
  finalizeCatalog: (catalog: { inputKind: "brand_catalog" | "product" | "search"; exhausted: boolean; truncated: boolean; expectedCount: number | null; discoveredCount: number; processedCount: number }) => Promise<unknown>;
}

export type GncCaptureCatalogResult =
  | { status: "complete"; itemCount: number; batchCount: number; discoveredCount: number; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number; batchCount: number };

export function gncInputKind(url: string): "brand_catalog" | "product" | "search" {
  const pathname = new URL(url).pathname;
  if (/\/\d{6}\.html$/i.test(pathname)) return "product";
  if (/^\/brands\/[^/]+\/?$/i.test(pathname)) return "brand_catalog";
  return "search";
}

/** 抓取产物 -> 统一契约。GNC 私有字段（family、mpn、factsText 全文等）保留在 products/<sku>.json 原始证据里。 */
export function toCapturedProduct(product: ExtractedGncProduct): CapturedProductV1 {
  const factsText = (product.factsText ?? "").trim();
  return {
    externalId: product.sku,
    sku: product.sku,
    productUrl: product.productUrl,
    brandRaw: product.brand,
    titleRaw: product.title,
    price: product.price,
    currency: product.currency,
    availability: product.inStock == null ? null : product.inStock ? "in_stock" : "out_of_stock",
    rating: product.rating,
    reviewCount: product.reviewCount == null ? null : Math.trunc(product.reviewCount),
    unitsSoldText: null,
    rawVariantAttrs: product.variantAttrs,
    descriptionText: product.description,
    detailText: product.detailText || null,
    ingredientText: null,
    factsEvidence: {
      htmlTable: hasCompleteFactsText(factsText) ? factsText : null,
      pdfUrl: product.labelPdfUrl,
      imageRefs: product.images,
    },
    images: product.images,
    sourceFiles: [`products/${product.sku}.json`],
    captureCompleteness: "full",
    capturedAt: product.capturedAt,
  };
}

/** 只有 Batch 里存在缺完整 HTML Facts、且有 PDF/图片证据可走的产品时才需要图片线。 */
export function batchImagesRequired(products: readonly ExtractedGncProduct[]) {
  return products.some((product) => !hasCompleteFactsText((product.factsText ?? "").trim())
    && (product.labelPdfUrl != null || product.images.length > 0));
}

/**
 * v2 capture_catalog：只负责目录发现、分页、商品抓取和 IP 轮动。
 * 每攒够 batchSize 个商品立即原子发布一个 Batch 并注册处理子 DAG——抓取线绝不等待处理线。
 * 不做 OCR、语义、Unify 或入库。
 */
export async function runGncCaptureCatalog(options: GncCaptureCatalogOptions): Promise<GncCaptureCatalogResult> {
  const root = runRoot(options.workRoot, options.runId);
  await fs.mkdir(root, { recursive: true });
  let discovery: GncDiscoveryResult;
  try {
    discovery = await discoverProductUrls({
      url: options.url,
      jobDirectory: root,
      maxItems: options.maxItems,
      signal: options.signal,
      ...(options.rotation ? { rotation: options.rotation } : {}),
    });
  } catch (error) {
    if (error instanceof GncAccessChallengeError) {
      return { status: "needs_review", reasonCode: "gnc_access_challenge", summary: error.message, itemCount: 0, batchCount: 0 };
    }
    throw error;
  }
  await writeJsonAtomic(path.join(root, "capture", "discovery.json"), discovery);
  if (discovery.urls.length === 0) {
    return { status: "needs_review", reasonCode: "gnc_no_products", summary: "GNC 页面没有发现商品 URL", itemCount: 0, batchCount: 0 };
  }

  const publisher = new BatchPublisher<ExtractedGncProduct>({
    channel: "gnc",
    adapter: "gnc",
    sourceType: "sales_channel",
    url: options.url,
    runId: options.runId,
    workRoot: options.workRoot,
    batchSize: options.batchSize,
    key: (product) => product.sku,
    toContract: toCapturedProduct,
    imagesRequired: batchImagesRequired,
    registerBatch: options.registerBatch,
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
  });
  await publisher.init();
  let capture;
  try {
    capture = await captureProducts({
      url: options.url,
      jobDirectory: root,
      maxItems: options.maxItems,
      signal: options.signal,
      ...(options.rotation ? { rotation: options.rotation } : {}),
      onProduct: (product) => publisher.add(product),
    }, discovery.urls);
    await publisher.flush();
  } catch (error) {
    // 挑战/网络故障中断时，已发布的 Batch 继续被处理线消费；本 job 进 Review 等人工/重试。
    if (error instanceof GncAccessChallengeError) {
      return {
        status: "needs_review", reasonCode: "gnc_access_challenge", summary: error.message,
        itemCount: 0, batchCount: publisher.batchCount,
      };
    }
    throw error;
  }

  await writeJsonAtomic(path.join(root, "capture", "capture.json"), {
    processedUrlCount: capture.processedUrlCount,
    queuedUrlCount: capture.queuedUrlCount,
    productCount: capture.products.length,
    truncated: capture.truncated,
    batchCount: publisher.batchCount,
  });
  await options.finalizeCatalog({
    inputKind: gncInputKind(options.url),
    exhausted: discovery.exhausted,
    truncated: discovery.truncated || capture.truncated,
    expectedCount: discovery.expectedCount,
    discoveredCount: capture.queuedUrlCount,
    processedCount: capture.processedUrlCount,
  });
  return {
    status: "complete",
    itemCount: capture.products.length,
    batchCount: publisher.batchCount,
    discoveredCount: capture.queuedUrlCount,
    summary: `GNC 抓取完成：商品 ${capture.products.length}，Batch ${publisher.batchCount}，URL ${capture.processedUrlCount}/${capture.queuedUrlCount}`,
  };
}
