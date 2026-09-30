import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { extractLabelJsonWithRepair, type StoredRawLabelVerdict } from "../amazon/label-extraction.js";
import { parseLabel, scoreConfidence } from "../amazon/label-parse.js";
import {
  buildHtmlFactsTablePrompt,
  buildOcrTextLabelPrompt,
  buildPdfTextLabelPrompt,
  hasFactsSignal,
  mapWithConcurrency,
  selectFactsOcrImages,
  type IndexedOcrImage,
} from "../amazon/ocr-label-pipeline.js";
import type { ProductFacts } from "../supply-smart-ingest.js";
import type { ExtractedGncProduct } from "./extract.js";

type ModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

type FactsExtractionMethod = "html_table" | "pdf_text" | "ocr";

export type GncFactsResult = {
  labelText: string;
  ingredientNames: string[];
  facts: ProductFacts | null;
  extractionMethod: FactsExtractionMethod | null;
  review?: string;
};

export type PdfTextPage = { index: number; text: string };

type StoredGncLabelVerdict = StoredRawLabelVerdict & {
  extractionMethod?: FactsExtractionMethod;
};

type GncFactsDependencies = {
  downloadLabel: (url: string, filename: string) => Promise<void>;
  extractPdfTextPages: (pdf: string, script: string) => Promise<PdfTextPage[]>;
  renderPages: (pdf: string, directory: string, script: string) => Promise<string[]>;
};

async function readJson<T>(filename: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")) as T; }
  catch { return null; }
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function downloadLabel(url: string, filename: string) {
  if (await fs.stat(filename).catch(() => null)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`GNC 标签下载失败 HTTP ${response.status}`);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, Buffer.from(await response.arrayBuffer()));
}

async function renderPages(pdf: string, directory: string, script: string) {
  const existing = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".png")).sort();
  if (existing.length > 0) return existing.map((name) => path.join(directory, name));
  await fs.mkdir(directory, { recursive: true });
  await promisify(execFile)("/usr/bin/swift", [script, pdf, directory], { timeout: 120_000 });
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".png")).sort();
  if (names.length === 0) throw new Error("GNC 标签 PDF 没有渲染出页面");
  return names.map((name) => path.join(directory, name));
}

async function extractPdfTextPages(pdf: string, script: string): Promise<PdfTextPage[]> {
  const { stdout } = await promisify(execFile)(
    "/usr/bin/swift",
    [script, "--extract-text", pdf],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const value = JSON.parse(stdout) as { pages?: Array<{ index?: unknown; text?: unknown }> };
  return (value.pages ?? []).flatMap((page) => {
    const index = Number(page.index);
    return Number.isInteger(index) && typeof page.text === "string" ? [{ index, text: page.text }] : [];
  });
}

/**
 * 数出文本里有多少个"剂量+单位"。
 *
 * 除了常规的 mg/mcg/IU/CFU，还要认酶制剂与益生菌的活性单位——酶产品的成分表
 * 通篇写的是 23,000 DU、80,000 HUT、4,000 FIP，一个 mg 都没有。只认常规单位
 * 会把这类完整的成分表判成"不完整"，白白退回去做 OCR。
 */
function amountTokenCount(text: string) {
  const conventional = "mcg|µg|ug|mg|g|iu|ml|cfu|billion|million|calories?";
  // 酶活性单位（FCC 体系）与益生菌计数单位
  const activity = "du|agu|hut|fip|cu|bgu|xu|galu|su|alu|lcu|hcu|pgu|endo-pgu|gdu|mcu|sapu|papu|apu|lapu|pc|fcc|usp";
  return text.match(new RegExp(`\\b\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${conventional}|${activity})\\b`, "gi"))?.length ?? 0;
}

/**
 * 只有 HTML 或 PDF 文字足以证明存在结构化 Facts 表格时才跳过后续回退。
 * 单独出现标题、Ingredients 或营销文案不算完整表格。
 */
export function hasCompleteFactsText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 120 || !hasFactsSignal({ text })) return false;
  const structureSignals = [
    /\bserving\s+size\b/i,
    /\bservings?\s+per\s+(?:container|package)\b/i,
    /\bamount\s+per\s+serving\b/i,
    /\b(?:%\s*)?daily\s+value\b/i,
    /\bactive\s+ingredients?\b/i,
    /\beach\s+(?:(?:chewable|vegetable|veggie)\s+)?(?:tablet|capsule|softgel|gummy)\s+contains\b/i,
  ].filter((pattern) => pattern.test(normalized)).length;
  return structureSignals >= 2 && amountTokenCount(normalized) >= 2;
}

export function selectCompleteFactsPdfTextPages(pages: readonly PdfTextPage[]): IndexedOcrImage[] {
  return pages
    .filter((page) => hasCompleteFactsText(page.text))
    .map((page) => ({
      index: page.index,
      fileName: `page-${String(page.index + 1).padStart(3, "0")}.pdf-text`,
      response: { detector: "pdf_text", recognizer: "pdfkit", text: page.text },
    }));
}

function isUsableVerdict(verdict: StoredRawLabelVerdict | null): verdict is StoredRawLabelVerdict {
  if (!verdict?.parsed) return false;
  return Boolean(verdict.parsed.skip || verdict.parsed.ambiguous || parseLabel(verdict.parsed));
}

function labelResult(options: {
  verdict: StoredRawLabelVerdict;
  labelText: string;
  method: FactsExtractionMethod;
  product: ExtractedGncProduct;
  runId: string;
}): GncFactsResult {
  const { verdict, labelText, method, product, runId } = options;
  if (!verdict.parsed) {
    return { labelText, ingredientNames: [], facts: null, extractionMethod: method, review: `${product.sku}: Codex 未返回可解析的标签结构` };
  }
  if (verdict.parsed.ambiguous) {
    return { labelText, ingredientNames: [], facts: null, extractionMethod: method, review: `${product.sku}: 官方标签含多套不同配方` };
  }
  if (verdict.parsed.skip) return { labelText, ingredientNames: [], facts: null, extractionMethod: method };
  const parsed = parseLabel(verdict.parsed);
  if (!parsed) {
    const evidence = method === "html_table" ? "HTML Facts 表格" : method === "pdf_text" ? "PDF 文字层" : "标签 OCR";
    return { labelText, ingredientNames: [], facts: null, extractionMethod: method, review: `${product.sku}: ${evidence}命中 Facts，但未形成合法成分行` };
  }
  const ingredientNames = [...new Set(parsed.rows.filter((row) => row.isActive).map((row) => row.rawText.trim()).filter(Boolean))];
  const sourceUrl = method === "html_table" ? product.productUrl : product.labelPdfUrl!;
  const sourceKind = method === "html_table" ? "gnc_label_html_table" : `gnc_label_pdf_${method === "pdf_text" ? "text" : "ocr"}`;
  return {
    labelText,
    ingredientNames,
    extractionMethod: method,
    facts: {
      channel: "gnc",
      externalId: product.sku,
      sourceUrl,
      capturedAt: product.capturedAt,
      source: `crawl-automation:${runId}:${sourceKind}`,
      confidence: scoreConfidence(verdict.parsed, parsed),
      ...(method === "html_table" ? {} : { sourceImageUrl: product.labelPdfUrl! }),
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
    },
  };
}

export async function extractGncFacts(options: {
  product: ExtractedGncProduct;
  root: string;
  runId: string;
  ocrConcurrency: number;
  ocr: OcrClient;
  pdfRenderScript: string;
  runModel: ModelCall;
}, dependencyOverrides: Partial<GncFactsDependencies> = {}): Promise<GncFactsResult> {
  const dependencies: GncFactsDependencies = {
    downloadLabel,
    extractPdfTextPages,
    renderPages,
    ...dependencyOverrides,
  };
  const root = path.join(options.root, options.product.sku);
  const htmlFactsText = (options.product.factsText ?? "").trim();
  const verdictFile = path.join(root, "label.raw.json");
  const stored = await readJson<StoredGncLabelVerdict>(verdictFile);
  if (stored && isUsableVerdict(stored)) {
    return labelResult({
      verdict: stored,
      labelText: htmlFactsText,
      method: stored.extractionMethod ?? "ocr",
      product: options.product,
      runId: options.runId,
    });
  }

  let htmlVerdict: StoredRawLabelVerdict | null = null;
  if (hasCompleteFactsText(htmlFactsText)) {
    const prompt = `${buildHtmlFactsTablePrompt(htmlFactsText)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
    htmlVerdict = await extractLabelJsonWithRepair({
      prompt,
      tag: `gnc-label-${options.product.sku}-html-table`,
      runModel: options.runModel,
    });
    if (isUsableVerdict(htmlVerdict)) {
      await writeJson(verdictFile, { ...htmlVerdict, extractionMethod: "html_table" });
      return labelResult({ verdict: htmlVerdict, labelText: htmlFactsText, method: "html_table", product: options.product, runId: options.runId });
    }
  }

  if (!options.product.labelPdfUrl) {
    return htmlVerdict
      ? labelResult({ verdict: htmlVerdict, labelText: htmlFactsText, method: "html_table", product: options.product, runId: options.runId })
      : { labelText: htmlFactsText, ingredientNames: [], facts: null, extractionMethod: null };
  }
  const pdf = path.join(root, `${options.product.sku}_lbl.pdf`);
  const pagesDirectory = path.join(root, "pages");
  await dependencies.downloadLabel(options.product.labelPdfUrl, pdf);

  const pdfTextFile = path.join(root, "pdf-text.json");
  let pdfTextPages = await readJson<PdfTextPage[]>(pdfTextFile);
  if (!pdfTextPages) {
    try {
      pdfTextPages = await dependencies.extractPdfTextPages(pdf, options.pdfRenderScript);
      await writeJson(pdfTextFile, pdfTextPages);
    } catch {
      pdfTextPages = [];
    }
  }
  const directPages = selectCompleteFactsPdfTextPages(pdfTextPages);
  const directLabelText = pdfTextPages.map((page) => page.text).filter(Boolean).join("\n\n");

  if (directPages.length > 0) {
    const prompt = `${buildPdfTextLabelPrompt(directPages)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
    const verdict = await extractLabelJsonWithRepair({
      prompt,
      tag: `gnc-label-${options.product.sku}-pdf-text`,
      runModel: options.runModel,
    });
    if (isUsableVerdict(verdict)) {
      await writeJson(verdictFile, { ...verdict, extractionMethod: "pdf_text" });
      return labelResult({ verdict, labelText: directLabelText, method: "pdf_text", product: options.product, runId: options.runId });
    }
  }

  const pages = await dependencies.renderPages(pdf, pagesDirectory, options.pdfRenderScript);
  const indexed = await mapWithConcurrency(pages, options.ocrConcurrency, async (filename, index): Promise<IndexedOcrImage> => {
    const cache = `${filename}.ocr.json`;
    let response = await readJson<any>(cache);
    if (!response) { response = await options.ocr.recognize(filename); await writeJson(cache, response); }
    return { index, fileName: path.basename(filename), response };
  });
  const labelText = indexed.map((item) => item.response.text ?? item.response.lines?.map((line) => line.text ?? "").join("\n") ?? "").join("\n\n");
  const selected = selectFactsOcrImages(indexed);
  if (selected.length === 0) return { labelText, ingredientNames: [], facts: null, extractionMethod: "ocr" };

  const prompt = `${buildOcrTextLabelPrompt(selected)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
  const verdict = await extractLabelJsonWithRepair({
    prompt,
    tag: `gnc-label-${options.product.sku}`,
    runModel: options.runModel,
  });
  await writeJson(verdictFile, { ...verdict, extractionMethod: "ocr" });
  return labelResult({ verdict, labelText, method: "ocr", product: options.product, runId: options.runId });
}
