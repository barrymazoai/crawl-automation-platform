import fs from "node:fs/promises";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { chunk } from "../amazon/semantic-clean.js";
import { mapWithConcurrency } from "../amazon/ocr-label-pipeline.js";
import { normalizedProductSchema, productBatchSchema, type NormalizedProduct, type ProductBatch, type ProductFacts, type SupplySmartDatabase } from "../supply-smart-ingest.js";
import { captureProducts, discoverProductUrls, GncAccessChallengeError } from "./capture.js";
import type { ExtractedGncProduct } from "./extract.js";
import { extractGncFacts, type GncFactsResult } from "./facts.js";
import { buildGncBatchPrompt, parseGncBatchOutput, type GncCleanInput, type GncCleanResult } from "./semantic.js";
import {
  runProductUnify,
  type ProductUnifyInput,
  type ProductUnifyOutcome,
  type ProductUnifyResult,
  type ProductVariant,
} from "../product-unify.js";
import type { ProductObservationClient } from "../product-observation-client.js";
import { decideSalesChannelScope } from "../sales-channel-scope.js";
import type { SalesChannelNavigationRotation } from "../sales-channel-egress/types.js";

type ModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

export interface GncPipelineOptions {
  url: string;
  runId: string;
  jobDirectory: string;
  maxItems: number;
  ocrConcurrency: number;
  signal: AbortSignal;
  ocr: OcrClient;
  supplySmart: SupplySmartDatabase;
  productWriter: ProductObservationClient;
  pdfRenderScript: string;
  runModel: ModelCall;
  rotation?: SalesChannelNavigationRotation;
}

export type GncPipelineResult =
  | { status: "complete"; itemCount: number; discoveredCount: number; excludedCount: number; factsCount: number; readbackHash: string; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number };

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("GNC pipeline aborted");
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readJson<T>(filename: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")) as T; }
  catch { return null; }
}

async function extractAllFacts(options: GncPipelineOptions, products: ExtractedGncProduct[]) {
  return mapWithConcurrency(products, Math.min(options.ocrConcurrency, 4), async (product) => {
    assertNotAborted(options.signal);
    return extractGncFacts({
      product,
      root: path.join(options.jobDirectory, "gnc", "labels"),
      runId: options.runId,
      // Products already run concurrently, so each PDF uses one page request at a time.
      // This keeps total OCR requests within OCR_IMAGE_CONCURRENCY.
      ocrConcurrency: 1,
      ocr: options.ocr,
      pdfRenderScript: options.pdfRenderScript,
      runModel: options.runModel,
    });
  });
}

async function semanticClean(options: GncPipelineOptions, products: ExtractedGncProduct[], facts: GncFactsResult[], vocabulary: string[]) {
  const filename = path.join(options.jobDirectory, "gnc", "semantic.json");
  const cached = await readJson<{ results: GncCleanResult[]; warnings: string[] }>(filename);
  if (cached) return cached;
  const inputs: GncCleanInput[] = products.map((product, index) => ({
    sku: product.sku,
    title: product.title,
    description: product.description,
    details: [product.detailText, product.factsText].filter(Boolean).join("\n"),
    labelText: facts[index]?.labelText ?? null,
    labelIngredients: facts[index]?.ingredientNames ?? [],
  }));
  const outcomes = await mapWithConcurrency(chunk(inputs, 50), 2, async (batch, index) => {
    const prompt = `${buildGncBatchPrompt(batch, vocabulary)}\nIMPORTANT: Return one object with one string field named payload, and serialize the requested JSON array exactly inside payload.`;
    const raw = await options.runModel({ prompt, tag: `gnc-semantic-${index}` });
    return parseGncBatchOutput(raw, batch, vocabulary);
  });
  const value = { results: outcomes.flatMap((item) => item.results), warnings: outcomes.flatMap((item) => item.problems) };
  await writeJson(filename, value);
  return value;
}

export function gncUnifyInput(product: ExtractedGncProduct, semantic: GncCleanResult): ProductUnifyInput {
  const structuredVariant: ProductVariant = {};
  if (product.variantAttrs.flavor) structuredVariant.flavor = product.variantAttrs.flavor;
  if (product.variantAttrs.size) structuredVariant.size = product.variantAttrs.size;
  if (product.variantAttrs.servings) structuredVariant.servings = product.variantAttrs.servings;
  return {
    clientRef: product.sku,
    channel: "gnc",
    titleRaw: product.title,
    brand: product.brand,
    structuredVariant,
    attrsRaw: product.variantAttrs,
    productFormHint: semantic.productForm === "other" ? null : semantic.productForm,
  };
}

async function unifyProducts(options: GncPipelineOptions, products: ExtractedGncProduct[], semanticBySku: Map<string, GncCleanResult>) {
  const filename = path.join(options.jobDirectory, "gnc", "product-unify.json");
  const cached = await readJson<ProductUnifyOutcome>(filename);
  if (cached) return cached;
  const inputs = products.flatMap((product) => {
    const semantic = semanticBySku.get(product.sku);
    return semantic?.scopeDecision === "included" ? [gncUnifyInput(product, semantic)] : [];
  });
  const outcome = await runProductUnify({ inputs, runModel: options.runModel, tagPrefix: "gnc-unify" });
  await writeJson(filename, outcome);
  return outcome;
}

function normalizeGtin(value: string | null) {
  const digits = value?.replace(/[^\d]/g, "") ?? "";
  return /^(?:\d{8}|\d{12,14})$/.test(digits) ? digits : undefined;
}

export function normalizeProduct(product: ExtractedGncProduct, semantic: GncCleanResult, unified: ProductUnifyResult, domain: string, runId: string, crawlScope: "full" | "partial"): NormalizedProduct {
  return normalizedProductSchema.parse({
    domain,
    productName: unified.productName,
    titleRaw: product.title,
    productUrl: product.productUrl,
    channel: "gnc",
    externalId: product.sku,
    sourceUrl: product.productUrl,
    capturedAt: product.capturedAt,
    crawlScope,
    source: `crawl-automation:${runId}`,
    sku: product.sku,
    skuMissing: false,
    ...(product.price ? { price: product.price } : {}),
    ...(product.currency ? { currency: product.currency } : {}),
    ...(product.rating != null ? { rating: product.rating } : {}),
    ...(product.reviewCount != null ? { reviewCount: Math.trunc(product.reviewCount) } : {}),
    ...(product.inStock != null ? { inStock: product.inStock } : {}),
    ...(product.variantAttrs.category ? { extras: { category: product.variantAttrs.category } } : {}),
    images: product.images,
    healthFunctions: semantic.healthFunctions,
    mainIngredients: semantic.ingredients,
    productForm: semantic.productForm,
    nutritionScope: { policy: "nutrition_single_products", decision: "included", evidence: semantic.scopeEvidence },
    ...(normalizeGtin(product.mpn) ? { gtin: normalizeGtin(product.mpn) } : {}),
    ...(unified.baseName ? { baseName: unified.baseName } : {}),
    variant: unified.variant,
    variantConfidence: unified.variantConfidence,
    variantSource: unified.variantSource,
    attrsRaw: unified.attrsRaw,
    variantAttrs: product.variantAttrs,
    family: product.family ? { ...product.family, label: product.variantAttrs.flavor ?? product.variantAttrs.size ?? product.title, evidence: "explicit" } : null,
  });
}

export async function runGncPipeline(options: GncPipelineOptions): Promise<GncPipelineResult> {
  await fs.mkdir(path.join(options.jobDirectory, "gnc"), { recursive: true });
  let discovery;
  try {
    discovery = await discoverProductUrls(options);
  } catch (error) {
    if (error instanceof GncAccessChallengeError) {
      const result = { status: "needs_review" as const, reasonCode: "gnc_access_challenge", summary: error.message, itemCount: 0 };
      await writeJson(path.join(options.jobDirectory, "gnc", "review.json"), result);
      return result;
    }
    throw error;
  }
  await writeJson(path.join(options.jobDirectory, "gnc", "discovery.json"), discovery);
  if (discovery.urls.length === 0) return { status: "needs_review", reasonCode: "gnc_no_products", summary: "GNC 页面没有发现商品 URL", itemCount: 0 };
  const capture = await captureProducts(options, discovery.urls);
  await writeJson(path.join(options.jobDirectory, "gnc", "capture.json"), {
    processedUrlCount: capture.processedUrlCount,
    queuedUrlCount: capture.queuedUrlCount,
    productCount: capture.products.length,
    truncated: capture.truncated,
  });
  const products = capture.products;
  const pathname = new URL(options.url).pathname;
  const inputKind = /\/\d{6}\.html$/i.test(pathname)
    ? "product" as const
    : /^\/brands\/[^/]+\/?$/i.test(pathname)
      ? "brand_catalog" as const
      : "search" as const;
  const scopeDecision = decideSalesChannelScope({
    inputKind,
    exhausted: discovery.exhausted,
    truncated: discovery.truncated || capture.truncated,
    expectedCount: discovery.expectedCount,
    discoveredCount: capture.queuedUrlCount,
    processedCount: capture.processedUrlCount,
  });
  const crawlScope = scopeDecision.scope;
  const factsResults = await extractAllFacts(options, products);
  const vocabulary = await options.supplySmart.loadHealthFunctions();
  const semantic = await semanticClean(options, products, factsResults, vocabulary);
  const semanticBySku = new Map(semantic.results.map((item) => [item.sku, item]));
  const unify = await unifyProducts(options, products, semanticBySku);
  const unifyBySku = new Map(unify.results.map((item) => [item.clientRef, item]));
  const blocking = factsResults.flatMap((item) => item.review ? [item.review] : []);
  const normalized: NormalizedProduct[] = [];
  const facts: ProductFacts[] = [];
  const domainCache = new Map<string, string | null>();
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index]!;
    const result = semanticBySku.get(product.sku);
    if (!result || result.scopeDecision !== "included") continue;
    const unified = unifyBySku.get(product.sku);
    if (!unified) { blocking.push(`${product.sku}: Product Unify 没有形成合法名称与变体结果`); continue; }
    if (!domainCache.has(product.brand)) {
      const resolved = await options.supplySmart.resolveCompanyDomain(product.brand);
      domainCache.set(product.brand, resolved ?? (/^GNC\b/i.test(product.brand) ? "gnc.com" : null));
    }
    const domain = domainCache.get(product.brand);
    if (!domain) { blocking.push(`${product.sku}: 品牌「${product.brand}」无法唯一映射到公司域名`); continue; }
    normalized.push(normalizeProduct(product, result, unified, domain, options.runId, crawlScope));
    if (factsResults[index]?.facts) facts.push(factsResults[index]!.facts!);
  }
  const batch: ProductBatch = productBatchSchema.parse({ schemaVersion: "2.0", products: normalized, facts });
  await writeJson(path.join(options.jobDirectory, "gnc", "product-batch.json"), batch);
  if (blocking.length > 0) {
    await writeJson(path.join(options.jobDirectory, "gnc", "review.json"), { blocking, warnings: [...semantic.warnings, ...unify.problems] });
    return { status: "needs_review", reasonCode: "gnc_data_review", summary: blocking.slice(0, 20).join("; "), itemCount: normalized.length };
  }
  const ingested = await options.productWriter.ingestAndValidate(batch, { runId: options.runId, sourceUrl: options.url });
  if (ingested.problems.length > 0 || ingested.verified !== batch.products.length) {
    await writeJson(path.join(options.jobDirectory, "gnc", "ingest-review.json"), ingested);
    return { status: "needs_review", reasonCode: "gnc_ingest_review", summary: ingested.problems.slice(0, 20).join("; ") || "产品库回读数量不一致", itemCount: normalized.length };
  }
  await writeJson(path.join(options.jobDirectory, "gnc", "ingest-result.json"), ingested);
  return {
    status: "complete",
    itemCount: normalized.length,
    discoveredCount: products.length,
    excludedCount: products.length - normalized.length,
    factsCount: facts.length,
    readbackHash: ingested.readbackHash,
    summary: `GNC 完成：发现 ${products.length}，入库并回读 ${normalized.length}，Facts ${facts.length}，scope=${scopeDecision.scope}${scopeDecision.reasons.length ? `（${scopeDecision.reasons.join(", ")}）` : ""}`,
  };
}
