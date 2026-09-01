import { describe, expect, it } from "vitest";
import { extractSwansonHtmlFacts } from "./facts-html.js";
import { hasCompleteFactsText } from "../gnc/facts.js";

// 取自真实页面（enzymedica-digest-gold-90-caps），含转义斜杠与商标符号
const REAL = `..."description": "Enzymedica's Digest Gold uses an exclusive Thera-blend process." , supplementFacts: " Supplement Facts Serving Size 1 Capsule Servings Per Container 90 Amount Per Serving % Daily Value Digest Gold\\u00ae Enzyme Blend 430 mg \\u2020 Carbohydrate-Digesting Enzymes Amylase Thera-blend (23,000 DU), Glucoamylase (50 AGU), Pectinase (w\\/Phytase) (45 Endo-PGU) Fat-Digesting Enzyme Lipase Thera-Blend (4,000 FIP)", otherIngredients: "100% Vegetarian Capsule (HPMC, water)", ...`;

describe("extractSwansonHtmlFacts", () => {
  it("从页面内嵌 JSON 里抠出成分表", () => {
    const result = extractSwansonHtmlFacts(REAL);
    expect(result?.field).toBe("supplementFacts");
    expect(result?.factsText).toContain("Serving Size 1 Capsule");
    expect(result?.factsText).toContain("Servings Per Container 90");
  });

  it("值里的转义引号与斜杠不会把提取截断", () => {
    // w\/Phytase 在值的中段，简单正则会在这里出错
    expect(extractSwansonHtmlFacts(REAL)?.factsText).toContain("Pectinase (w/Phytase) (45 Endo-PGU)");
  });

  it("还原 unicode 转义，商标符号不留下 \\u00ae", () => {
    const text = extractSwansonHtmlFacts(REAL)!.factsText;
    expect(text).toContain("Digest Gold®");
    expect(text).not.toContain("\\u00ae");
  });

  it("把单列的辅料并进正文", () => {
    expect(extractSwansonHtmlFacts(REAL)?.factsText).toContain("100% Vegetarian Capsule");
  });

  it("抠出来的内容能通过 GNC 那套完整性判定——这是不走 OCR 的前提", () => {
    expect(hasCompleteFactsText(extractSwansonHtmlFacts(REAL)!.factsText)).toBe(true);
  });

  it("页面没有成分表时返回 null，交给图片线兜底", () => {
    expect(extractSwansonHtmlFacts(`{"title":"x","description":"只有营销文案"}`)).toBeNull();
  });

  it("字段存在但内容太短也算没有，不拿半截数据去判定", () => {
    expect(extractSwansonHtmlFacts(`supplementFacts: "见包装"`)).toBeNull();
  });
});
