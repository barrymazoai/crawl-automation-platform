import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractedGncProduct } from "./extract.js";
import { extractGncFacts, hasCompleteFactsText } from "./facts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gnc-facts-"));
  roots.push(root);
  return root;
}

const product = {
  sku: "877172",
  title: "Ultimate Omega",
  brand: "Nordic Naturals",
  productUrl: "https://www.gnc.com/fish-oil-omegas/877172.html",
  labelPdfUrl: "https://www.gnc.com/example/877172_lbl.pdf",
  factsText: "",
  capturedAt: "2026-08-31T00:00:00.000Z",
} as ExtractedGncProduct;

const completeText = `
Supplement Facts
Serving Size: 2 Soft Gels
Servings per container: 90
Amount Per Serving % Daily Value
Total Omega-3s 1280 mg
EPA (Eicosapentaenoic Acid) 650 mg
DHA (Docosahexaenoic Acid) 450 mg
Other Omega-3s 180 mg
`;

const modelPayload = JSON.stringify({
  panelType: "supplement_facts",
  factsImages: [0],
  servingSize: "2 Soft Gels",
  servingsPerContainer: "90",
  activeIngredients: [
    { raw: "Total Omega-3s", amount: "1280 mg", dv: null, indent: 0 },
    { raw: "EPA (Eicosapentaenoic Acid)", amount: "650 mg", dv: null, indent: 0 },
  ],
  otherIngredients: [],
  unreadable: [],
});

describe("GNC PDF text-first facts extraction", () => {
  it("only accepts a complete structured Facts text layer", () => {
    expect(hasCompleteFactsText(completeText)).toBe(true);
    expect(hasCompleteFactsText("Ingredients Serving Size 2 Softgels Servings Per Container 90 Amount Per Serving % DV Total Omega-3s 1280 mg EPA 650 mg DHA 450 mg")).toBe(true);
    expect(hasCompleteFactsText("Supplement Facts Ingredients")).toBe(false);
    expect(hasCompleteFactsText("Long marketing copy ".repeat(20))).toBe(false);
  });

  it("uses the HTML Ingredients table without downloading the PDF", async () => {
    const root = await temporaryRoot();
    let downloadCalls = 0;
    let ocrCalls = 0;
    const result = await extractGncFacts({
      product: { ...product, labelPdfUrl: null, factsText: completeText },
      root,
      runId: "run-html",
      ocrConcurrency: 1,
      ocr: { recognize: async () => { ocrCalls += 1; throw new Error("OCR should not run"); } } as unknown as OcrClient,
      pdfRenderScript: "/unused/render.swift",
      runModel: async ({ prompt }) => {
        expect(prompt).toContain("Ingredients Accordion 中 HTML Facts 表格");
        return modelPayload;
      },
    }, {
      downloadLabel: async () => { downloadCalls += 1; throw new Error("PDF should not download"); },
      extractPdfTextPages: async () => { throw new Error("PDF text should not run"); },
      renderPages: async () => { throw new Error("render should not run"); },
    });
    expect(downloadCalls).toBe(0);
    expect(ocrCalls).toBe(0);
    expect(result.extractionMethod).toBe("html_table");
    expect(result.facts?.sourceUrl).toBe(product.productUrl);
    expect(result.facts?.sourceImageUrl).toBeUndefined();
    expect(result.facts?.source).toContain("gnc_label_html_table");
  });

  it("skips rendering and OCR when the PDF text layer is complete", async () => {
    const root = await temporaryRoot();
    let ocrCalls = 0;
    let renderCalls = 0;
    const result = await extractGncFacts({
      product,
      root,
      runId: "run-text",
      ocrConcurrency: 1,
      ocr: { recognize: async () => { ocrCalls += 1; throw new Error("OCR should not run"); } } as unknown as OcrClient,
      pdfRenderScript: "/unused/render.swift",
      runModel: async ({ prompt }) => {
        expect(prompt).toContain("PDF 的可选择文字层");
        return modelPayload;
      },
    }, {
      downloadLabel: async (_url, filename) => { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, "pdf"); },
      extractPdfTextPages: async () => [{ index: 0, text: completeText }],
      renderPages: async () => { renderCalls += 1; return []; },
    });
    expect(ocrCalls).toBe(0);
    expect(renderCalls).toBe(0);
    expect(result.extractionMethod).toBe("pdf_text");
    expect(result.ingredientNames).toEqual(["Total Omega-3s", "EPA (Eicosapentaenoic Acid)"]);
    expect(result.facts?.source).toContain("gnc_label_pdf_text");
  });

  it("falls back to rendered-page OCR when the text layer is incomplete", async () => {
    const root = await temporaryRoot();
    let ocrCalls = 0;
    const result = await extractGncFacts({
      product,
      root,
      runId: "run-ocr",
      ocrConcurrency: 1,
      ocr: {
        recognize: async () => {
          ocrCalls += 1;
          return { text: completeText };
        },
      } as unknown as OcrClient,
      pdfRenderScript: "/unused/render.swift",
      runModel: async () => modelPayload,
    }, {
      downloadLabel: async (_url, filename) => { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, "pdf"); },
      extractPdfTextPages: async () => [{ index: 0, text: "Supplement Facts" }],
      renderPages: async () => [path.join(root, "page-001.png")],
    });
    expect(ocrCalls).toBe(1);
    expect(result.extractionMethod).toBe("ocr");
    expect(result.facts?.source).toContain("gnc_label_pdf_ocr");
  });
});
