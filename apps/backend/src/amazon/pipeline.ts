import fs from "node:fs/promises";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { createPageHolder } from "./browser.js";
import {
  MAX_SEARCH_PAGES,
  SEARCH_PAGE_SCRIPT,
  VARIATION_PAGE_SCRIPT,
  parseSearchPage,
  type RawSearchPage,
  type RawVariationPage,
} from "./amazon-search.js";
import { extractVariationFamily, type VariationFamily } from "./link-check.js";
import { extractProduct, type ExtractedProduct } from "./extract-product.js";
import { readSnapshot, saveSnapshot } from "./snapshot.js";
import {
  buildBatchPrompt,
  chunk,
  parseBatchOutput,
  type CleanInput,
  type CleanResult,
} from "./semantic-clean.js";
import {
  buildOcrTextLabelPrompt,
  mapWithConcurrency,
  selectFactsOcrImages,
  type IndexedOcrImage,
} from "./ocr-label-pipeline.js";
import { extractLabelJson } from "./label-extraction.js";
import { parseLabel, scoreConfidence } from "./label-parse.js";
import { toEnrichPayload } from "./to-enrich-payload.js";
import {
  normalizedProductSchema,
  productBatchSchema,
  type NormalizedProduct,
  type ProductBatch,
  type ProductFacts,
  type SupplySmartApi,
} from "../supply-smart-ingest.js";

const ASIN_RE = /^[A-Z0-9]{10}$/;
const GENERIC_ASIN_SCRIPT = `(() => ({
  blocked: document.documentElement.innerHTML.includes('validateCaptcha') ||
    document.body.innerText.includes('Enter the characters you see below'),
  asins: [...new Set([...document.querySelectorAll('a[href*="/dp/"],a[href*="/gp/product/"]')]
    .map(a => (a.getAttribute('href') || '').match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase())
    .filter(Boolean))]
}))()`;

type ModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

export interface AmazonPipelineOptions {
  url: string;
  runId: string;
  jobDirectory: string;
  maxItems: number;
  ocrConcurrency: number;
  signal: AbortSignal;
  ocr: OcrClient;
  supplySmart: SupplySmartApi;
  runModel: ModelCall;
}

export type AmazonPipelineResult =
  | { status: "complete"; itemCount: number; discoveredCount: number; excludedCount: number; factsCount: number; readbackHash: string; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number };

type CapturedProduct = {
  asin: string;
  capturedAt: string;
  extracted: ExtractedProduct;
  family: VariationFamily;
  familyLabel: string | null;
};

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Amazon pipeline aborted");
}

async function exists(filename: string) {
  return Boolean(await fs.stat(filename).catch(() => null));
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readJson<T>(filename: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as T;
  } catch {
    return null;
  }
}

function directAsin(url: string) {
  return new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null;
}

function pageUrl(source: string, page: number) {
  const url = new URL(source);
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  return url.toString();
}

function brandHint(url: string) {
  const value = new URL(url).searchParams.get("k") ?? new URL(url).searchParams.get("field-keywords") ?? "Amazon";
  return value.trim() || "Amazon";
}

async function discoverInitialAsins(url: string, maxItems: number) {
  const direct = directAsin(url);
  if (direct) return [direct];

  const holder = createPageHolder();
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= MAX_SEARCH_PAGES && seen.size < maxItems; page += 1) {
      const raw = await holder.run(async (browser) => {
        await browser.navigate(pageUrl(url, page));
        return browser.evaluate<RawSearchPage>(SEARCH_PAGE_SCRIPT);
      });
      if (raw.blocked) throw new Error(`Amazon 搜索第 ${page} 页被挑战页拦截`);
      const parsed = parseSearchPage(raw, brandHint(url), seen);
      if (parsed.results.length === 0) {
        if (page === 1) {
          const generic = await holder.run(async (browser) => browser.evaluate<{ blocked: boolean; asins: string[] }>(GENERIC_ASIN_SCRIPT));
          if (generic.blocked) throw new Error("Amazon 页面被挑战页拦截");
          for (const asin of generic.asins ?? []) if (ASIN_RE.test(asin)) seen.add(asin);
        }
        break;
      }
    }
  } finally {
    await holder.close();
  }
  return [...seen].slice(0, maxItems);
}

function labelForAsin(family: VariationFamily, asin: string) {
  return family.members.find((member) => member.asin === asin)?.label?.trim() || null;
}

async function captureProducts(options: AmazonPipelineOptions, initial: string[]): Promise<CapturedProduct[]> {
  const root = path.join(options.jobDirectory, "amazon");
  const pageDirectory = path.join(root, "pages");
  const extractedDirectory = path.join(root, "extracted");
  const holder = createPageHolder();
  const queued = [...initial];
  const known = new Set(queued);
  const products: CapturedProduct[] = [];

  try {
    for (let cursor = 0; cursor < queued.length && products.length < options.maxItems; cursor += 1) {
      assertNotAborted(options.signal);
      const asin = queued[cursor]!;
      const extractedFile = path.join(extractedDirectory, `${asin}.json`);
      const cached = await readJson<CapturedProduct>(extractedFile);
      if (cached) {
        products.push(cached);
        for (const member of cached.family.members) {
          if (!known.has(member.asin) && known.size < options.maxItems) { known.add(member.asin); queued.push(member.asin); }
        }
        continue;
      }

      let html = await readSnapshot(asin, pageDirectory);
      let family: VariationFamily = { parentAsin: null, members: [] };
      if (!html) {
        const raw = await holder.run(async (browser) => {
          const status = await browser.navigate(`${new URL(options.url).origin}/dp/${asin}`);
          const page = await browser.evaluate<RawVariationPage>(VARIATION_PAGE_SCRIPT);
          return { status, page };
        });
        if (!raw.page.readable || !raw.page.fullHtml) {
          throw new Error(`${asin}: Amazon 商品页不可读（HTTP ${raw.status || "unknown"}）`);
        }
        html = raw.page.fullHtml;
        family = extractVariationFamily(raw.page.fragment || html);
        await saveSnapshot(asin, html, pageDirectory);
      } else {
        family = extractVariationFamily(html);
      }

      for (const member of family.members) {
        if (ASIN_RE.test(member.asin) && !known.has(member.asin) && known.size < options.maxItems) {
          known.add(member.asin);
          queued.push(member.asin);
        }
      }
      const captured: CapturedProduct = {
        asin,
        capturedAt: new Date().toISOString(),
        extracted: extractProduct(html),
        family,
        familyLabel: labelForAsin(family, asin),
      };
      await writeJson(extractedFile, captured);
      products.push(captured);
    }
  } finally {
    await holder.close();
  }
  return products;
}

function cleanInput(product: CapturedProduct): CleanInput {
  return {
    asin: product.asin,
    title: product.extracted.title,
    formField: product.extracted.itemForm,
    bullets: product.extracted.bullets,
    description: product.extracted.description,
    aplusText: product.extracted.aplusText,
    ingredientsRaw: product.extracted.ingredientsText,
  };
}

async function semanticClean(options: AmazonPipelineOptions, products: CapturedProduct[], vocabulary: string[]) {
  const cacheFile = path.join(options.jobDirectory, "amazon", "semantic.json");
  const cached = await readJson<{ results: CleanResult[]; warnings: string[] }>(cacheFile);
  if (cached) return cached;

  const inputs = products.map(cleanInput);
  const batches = chunk(inputs, 50);
  const outcomes = await mapWithConcurrency(batches, 2, async (batch, index) => {
    const prompt = `${buildBatchPrompt(batch, vocabulary)}\nIMPORTANT: the runner wrapper overrides the earlier top-level output sentence. Return one object with one string field named payload, and put the requested JSON array serialized exactly inside payload.`;
    const payload = await options.runModel({ prompt, tag: `semantic-${index}` });
    return parseBatchOutput(payload, batch, vocabulary);
  });
  const value = {
    results: outcomes.flatMap((outcome) => outcome.results),
    warnings: outcomes.flatMap((outcome) => outcome.problems),
  };
  await writeJson(cacheFile, value);
  return value;
}

function imageExtension(contentType: string | null, url: string) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  const match = new URL(url).pathname.match(/\.(png|webp|gif|jpe?g)$/i)?.[0];
  return match?.toLowerCase() ?? ".jpg";
}

async function downloadImages(product: CapturedProduct, root: string, concurrency: number) {
  const directory = path.join(root, product.asin);
  await fs.mkdir(directory, { recursive: true });
  return mapWithConcurrency(product.extracted.images, concurrency, async (url, index) => {
    const stem = String(index).padStart(2, "0");
    const existing = (await fs.readdir(directory)).find((name) => name.startsWith(`${stem}.`) && !name.endsWith(".ocr.json"));
    if (existing) return path.join(directory, existing);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`${product.asin}: 图片 ${index} 下载失败 HTTP ${response.status}`);
    const filename = path.join(directory, `${stem}${imageExtension(response.headers.get("content-type"), url)}`);
    await fs.writeFile(filename, Buffer.from(await response.arrayBuffer()));
    return filename;
  });
}

async function extractFacts(options: AmazonPipelineOptions, product: CapturedProduct): Promise<ProductFacts | null | { review: string }> {
  if (product.extracted.images.length === 0) return null;
  const images = await downloadImages(product, path.join(options.jobDirectory, "amazon", "images"), options.ocrConcurrency);
  const ocrImages = await mapWithConcurrency(images, options.ocrConcurrency, async (filename, index): Promise<IndexedOcrImage> => {
    const cache = `${filename}.ocr.json`;
    let response = await readJson<any>(cache);
    if (!response) {
      response = await options.ocr.recognize(filename);
      await writeJson(cache, response);
    }
    return { index, fileName: path.basename(filename), response };
  });
  const selected = selectFactsOcrImages(ocrImages);
  if (selected.length === 0) return null;

  const verdictFile = path.join(options.jobDirectory, "amazon", "images", product.asin, "label.raw.json");
  let verdict = await readJson<any>(verdictFile);
  if (!verdict) {
    const prompt = `${buildOcrTextLabelPrompt(selected)}\nIMPORTANT: the runner wrapper overrides the earlier top-level output sentence. Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
    const payload = await options.runModel({ prompt, tag: `label-${product.asin}` });
    const parsedJson = extractLabelJson(payload);
    verdict = { raw: payload, parsed: parsedJson };
    await writeJson(verdictFile, verdict);
  }
  if (verdict.parsed?.ambiguous) return { review: `${product.asin}: OCR 发现多张不同配方，不能合并` };
  if (verdict.parsed?.skip) return null;
  const parsed = parseLabel(verdict.parsed ?? null);
  if (!parsed) return { review: `${product.asin}: OCR 命中 Facts 结构，但语义解析未形成合法成分行` };

  return {
    channel: "amazon",
    externalId: product.asin,
    sourceUrl: `${new URL(options.url).origin}/dp/${product.asin}`,
    capturedAt: product.capturedAt,
    source: `crawl-automation:${options.runId}:label_ocr`,
    confidence: scoreConfidence(verdict.parsed, parsed),
    servingSize: parsed.servingSize,
    servingUnit: parsed.servingUnit,
    servingsPerContainer: parsed.servingsPerContainer,
    rows: parsed.rows.map((row) => ({
      name: row.rawText,
      amountValue: row.amountValue,
      amountUnit: row.amountUnit,
      dvPercent: row.dvPercent,
      position: row.position,
      isActive: row.isActive,
      parentPosition: row.parentIndex == null ? null : parsed.rows[row.parentIndex]?.position ?? null,
    })),
  };
}

function normalizeUnitsPeriod(value: string | undefined) {
  if (!value) return undefined;
  if (value === "month") return "monthly" as const;
  return "unknown" as const;
}

function normalizeAmazonProduct(product: CapturedProduct, semantic: CleanResult, domain: string, runId: string, sourceOrigin: string): NormalizedProduct {
  const payload = toEnrichPayload({
    asin: product.asin,
    extracted: product.extracted,
    semantic,
    companyDomain: domain,
    capturedAt: new Date(product.capturedAt),
    source: `crawl-automation:${runId}`,
  });
  return normalizedProductSchema.parse({
    ...payload,
    productUrl: `${sourceOrigin}/dp/${product.asin}`,
    sourceUrl: `${sourceOrigin}/dp/${product.asin}`,
    unitsSoldPeriod: normalizeUnitsPeriod(payload.unitsSoldPeriod),
    sku: null,
    skuMissing: true,
    family: product.family.parentAsin || product.family.members.length > 1 ? {
      parentExternalId: product.family.parentAsin,
      label: product.familyLabel,
      evidence: "explicit",
    } : null,
    variantAttrs: {
      ...(payload.variantAttrs ?? {}),
      ...(product.familyLabel ? { label: product.familyLabel } : {}),
    },
  });
}

export async function runAmazonPipeline(options: AmazonPipelineOptions): Promise<AmazonPipelineResult> {
  await fs.mkdir(path.join(options.jobDirectory, "amazon"), { recursive: true });
  const initial = await discoverInitialAsins(options.url, options.maxItems);
  if (initial.length === 0) {
    return { status: "needs_review", reasonCode: "amazon_no_asin", summary: "Amazon 页面没有发现 ASIN", itemCount: 0 };
  }

  const products = await captureProducts(options, initial);
  const vocabulary = await options.supplySmart.loadHealthFunctions();
  const semantic = await semanticClean(options, products, vocabulary);
  const semanticByAsin = new Map(semantic.results.map((result) => [result.asin, result]));
  const included = products.filter((product) => semanticByAsin.get(product.asin)?.scopeDecision === "included");
  const blocking: string[] = [];
  const domainCache = new Map<string, string | null>();
  const normalized: NormalizedProduct[] = [];
  const facts: ProductFacts[] = [];

  for (const product of included) {
    assertNotAborted(options.signal);
    const semanticResult = semanticByAsin.get(product.asin)!;
    const brand = product.extracted.brand?.trim();
    if (!brand) { blocking.push(`${product.asin}: 页面没有可验证品牌`); continue; }
    if (!domainCache.has(brand)) domainCache.set(brand, await options.supplySmart.resolveCompanyDomain(brand));
    const domain = domainCache.get(brand);
    if (!domain) { blocking.push(`${product.asin}: 品牌「${brand}」无法唯一映射到公司域名`); continue; }
    normalized.push(normalizeAmazonProduct(product, semanticResult, domain, options.runId, new URL(options.url).origin));
    const extractedFacts = await extractFacts(options, product);
    if (extractedFacts && "review" in extractedFacts) blocking.push(extractedFacts.review);
    else if (extractedFacts) facts.push(extractedFacts);
  }

  const batch: ProductBatch = productBatchSchema.parse({ schemaVersion: "2.0", products: normalized, facts });
  await writeJson(path.join(options.jobDirectory, "amazon", "product-batch.json"), batch);
  if (blocking.length > 0) {
    await writeJson(path.join(options.jobDirectory, "amazon", "review.json"), { blocking, warnings: semantic.warnings });
    return {
      status: "needs_review",
      reasonCode: "amazon_data_review",
      summary: blocking.slice(0, 20).join("; "),
      itemCount: normalized.length,
    };
  }

  const ingested = await options.supplySmart.ingestAndValidate(batch);
  if (ingested.problems.length > 0 || ingested.verified !== batch.products.length) {
    await writeJson(path.join(options.jobDirectory, "amazon", "ingest-review.json"), ingested);
    return {
      status: "needs_review",
      reasonCode: "amazon_ingest_review",
      summary: ingested.problems.slice(0, 20).join("; ") || "Jakarta 回读数量不一致",
      itemCount: normalized.length,
    };
  }
  await writeJson(path.join(options.jobDirectory, "amazon", "ingest-result.json"), ingested);
  return {
    status: "complete",
    itemCount: normalized.length,
    discoveredCount: products.length,
    excludedCount: products.length - included.length,
    factsCount: facts.length,
    readbackHash: ingested.readbackHash,
    summary: `Amazon 完成：发现 ${products.length}，入库并回读 ${normalized.length}，Facts ${facts.length}`,
  };
}
