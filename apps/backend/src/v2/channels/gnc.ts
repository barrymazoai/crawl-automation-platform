import path from "node:path";
import { chunk } from "../../amazon/semantic-clean.js";
import { mapWithConcurrency } from "../../amazon/ocr-label-pipeline.js";
import { extractGncFacts, hasCompleteFactsText, type GncFactsResult } from "../../gnc/facts.js";
import type { ExtractedGncProduct } from "../../gnc/extract.js";
import { buildGncBatchPrompt, parseGncBatchOutput, type GncCleanInput, type GncCleanResult } from "../../gnc/semantic.js";
import { gncUnifyInput, normalizeProduct } from "../../gnc/pipeline.js";
import { runRoot } from "../paths.js";
import type { ChannelHooks, StageContext } from "../stages.js";

/**
 * GNC 的 ChannelHooks 实现：只有渠道差异（语义 prompt、Facts 提取阶梯、normalize），
 * 编排规则全部在 v2/stages.ts，新增渠道照这个文件的形状实现即可。
 */
export function createGncChannelHooks(config: { pdfRenderScript: string }): ChannelHooks<ExtractedGncProduct, GncCleanResult, GncFactsResult> {
  const domainCache = new Map<string, string | null>();
  return {
    channel: "gnc",
    key: (product) => product.sku,
    describe: (product) => ({ title: product.title, productUrl: product.productUrl }),
    brand: (product) => product.brand || null,
    sidelineFields: (product) => ({ sku: product.sku, price: product.price ?? null, capturedAt: product.capturedAt }),

    async clean(ctx, products, tagPrefix) {
      const vocabulary = await ctx.supplySmart.loadHealthFunctions();
      const inputs: GncCleanInput[] = products.map((product) => ({
        sku: product.sku,
        title: product.title,
        description: product.description,
        details: [product.detailText, product.factsText].filter(Boolean).join("\n"),
        // 文字线不等待图片线：labelText 使用页面自带的 factsText（HTML 表格与 Ingredients 文本）。
        labelText: (product.factsText ?? "").trim() || null,
        labelIngredients: [],
      }));
      const outcomes = await mapWithConcurrency(chunk(inputs, 50), 2, async (batch, index) => {
        const prompt = `${buildGncBatchPrompt(batch, vocabulary)}\nIMPORTANT: Return one object with one string field named payload, and serialize the requested JSON array exactly inside payload.`;
        const raw = await ctx.runModel({ prompt, tag: `${tagPrefix}-${index}` });
        return parseGncBatchOutput(raw, batch, vocabulary);
      });
      return { results: outcomes.flatMap((item) => item.results), warnings: outcomes.flatMap((item) => item.problems) };
    },
    semanticKey: (semantic) => semantic.sku,
    included: (semantic) => semantic.scopeDecision === "included",

    htmlFactsReady: (product) => hasCompleteFactsText((product.factsText ?? "").trim()),
    extractFacts: (ctx: StageContext, product) => extractGncFacts({
      product,
      root: path.join(runRoot(ctx.workRoot, ctx.runId), "labels"),
      runId: ctx.runId,
      // 产品级已并行，产品内 OCR 串行，总 OCR 并发受编排层约束。
      ocrConcurrency: 1,
      ocr: ctx.ocr,
      pdfRenderScript: config.pdfRenderScript,
      runModel: ctx.runModel,
    }),

    unifyInput: (product, semantic) => gncUnifyInput(product, semantic),

    async resolveDomain(ctx, product) {
      if (!domainCache.has(product.brand)) {
        const resolved = await ctx.supplySmart.resolveCompanyDomain(product.brand);
        domainCache.set(product.brand, resolved ?? (/^GNC\b/i.test(product.brand) ? "gnc.com" : null));
      }
      return domainCache.get(product.brand) ?? null;
    },

    normalize: (ctx, input) => normalizeProduct(input.product, input.semantic, input.unified, input.domain, ctx.runId, input.scope),
  };
}
