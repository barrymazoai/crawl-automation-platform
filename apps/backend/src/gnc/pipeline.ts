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


// v1 单体编排 runGncPipeline 已删除：GNC 现在走 workers/capture-gnc.ts + v2/channels/gnc.ts
