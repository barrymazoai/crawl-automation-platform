import { describe, expect, it } from "vitest";
import { parseSwansonConstructorPage, swansonVariantAttrsFromRaw } from "./pipeline.js";

describe("Swanson fixed adapter", () => {
  it("expands Constructor variations into independent Swanson handles", () => {
    const parsed = parseSwansonConstructorPage({ response: {
      total_num_results: 1,
      results: [{
        value: "Creatine Gummies",
        data: { id: "P-SW1969", brand: "Swanson Vitamins", form: "Gummies", url: "wild-berry", variation_id: "SW1970" },
        variations: [
          { data: { url: "wild-berry", variation_id: "SW1970", flavor: "Wild Berry" } },
          { data: { url: "watermelon", variation_id: "SW1969", flavor: "Watermelon" } },
        ],
      }],
    } });
    expect(parsed.total).toBe(1);
    expect(parsed.resultCount).toBe(1);
    expect(parsed.entries.map((entry) => [entry.handle, entry.data.variation_id])).toEqual([
      ["wild-berry", "SW1970"],
      ["watermelon", "SW1969"],
    ]);
  });

  it("splits Swanson pfdesc into a canonical size and form", () => {
    expect(swansonVariantAttrsFromRaw({
      flavor: "Dark Chocolate",
      pfdesc: "22 oz Pwdr",
      form: null,
    })).toEqual({ flavor: "Dark Chocolate", size: "22 oz", form: "powder" });
    expect(swansonVariantAttrsFromRaw({
      option1: "Default Title",
      pfdesc: "50 Billion CFU 60 Caps",
      potent: "50 Billion CFU",
      form: "Caps",
    })).toEqual({ size: "60 Count", strength: "50 Billion CFU", form: "capsule" });
  });
});

describe("Constructor 接入参数缓存", () => {
  it("清缓存的接口存在——key 失效时要能强制重取", async () => {
    const { clearSwansonApiConfigCache } = await import("./pipeline.js");
    expect(typeof clearSwansonApiConfigCache).toBe("function");
    expect(() => clearSwansonApiConfigCache()).not.toThrow();
  });
});

describe("Facts 解析优先用页面成分表", () => {
  const factsText = "Supplement Facts Serving Size One (1) Capsule Servings Per Container 30 "
    + "Amount Per Serving % Daily Value Calories 0 Total Carbohydrate 0 g 0% "
    + "Lactobacillus rhamnosus GG 40 mg (10 billion CFUs) Inulin (Chicory Root Extract) 200 mg "
    + "Other Ingredients: hydroxypropyl methylcellulose, vegetable magnesium stearate.";
  // images 留空：一旦走到图片线就会真的去下载，测试里不许发生
  const product = {
    externalId: "CUL001",
    productUrl: "https://www.swansonvitamins.com/products/x",
    capturedAt: new Date().toISOString(),
    images: [],
    factsText,
  } as any;

  it("页面成分表完整时先送 HTML 解析，不走 OCR", async () => {
    const { extractFacts } = await import("./pipeline.js");
    const tags: string[] = [];
    await extractFacts({
      jobDirectory: "/tmp/不应被使用", runId: "run-1", ocrConcurrency: 1,
      ocr: { recognize: () => { throw new Error("不应调用 OCR"); } },
      runModel: async ({ tag }: { tag: string }) => { tags.push(tag); return "{}"; },
    } as any, product);
    // 标签带 html-table 后缀，证明走的是页面成分表那条路
    expect(tags).toContain("swanson-label-CUL001-html-table");
    expect(tags.some((tag) => tag === "swanson-label-CUL001")).toBe(false);
  });

  it("页面没有成分表且没有图片时如实返回空，不编造", async () => {
    const { extractFacts } = await import("./pipeline.js");
    const result = await extractFacts({
      jobDirectory: "/tmp/x", runId: "run-1", ocrConcurrency: 1,
      ocr: { recognize: async () => ({}) }, runModel: async () => "{}",
    } as any, { ...product, factsText: null });
    expect(result.facts).toBeNull();
    expect(result.review).toBeNull();
  });
});
