import { describe, expect, it } from "vitest";
import { BrandCatalogMatcher } from "./matcher.js";

const catalog = [
  { slug: "enzymedica", label: "Enzymedica®" },
  { slug: "alani-nu", label: "Alani Nu" },
  { slug: "amazing-nutrition", label: "Amazing Nutrition" },
  { slug: "amazing-muscle", label: "Amazing Muscle" },
  { slug: "avid", label: "Avid" },
  { slug: "ancient-nutrition", label: "Ancient Nutrition" },
  { slug: "one-of-one", label: "101™" },
];
const matcher = new BrandCatalogMatcher(catalog);

describe("BrandCatalogMatcher", () => {
  it("忽略商标符号与法律后缀，得到 exact 匹配", () => {
    expect(matcher.match(["Enzymedica"])).toMatchObject({ slug: "enzymedica", tier: "exact" });
    expect(matcher.match(["Alani Nutrition LLC", "Alani Nu"])).toMatchObject({ slug: "alani-nu" });
  });

  it("忽略 Nutrition / Labs 这类行业词的有无，得到 strong 匹配", () => {
    expect(matcher.match(["Amazing Nutrition Inc."])).toMatchObject({ slug: "amazing-nutrition", tier: "exact" });
    expect(matcher.match(["Enzymedica Labs"])).toMatchObject({ slug: "enzymedica", tier: "strong" });
  });

  it("不做子串匹配：Altavida 不能命中 Avid", () => {
    expect(matcher.match(["Altavida"])).toBeNull();
  });

  it("共用词元不唯一时不匹配：Amazing Muscle 不能命中 Amazing Nutrition", () => {
    // amazing 被目录里两个品牌共用，只靠它不足以定位
    expect(matcher.match(["Amazing Muscle"])).toMatchObject({ slug: "amazing-muscle", tier: "exact" });
    expect(matcher.match(["Amazing Formulas"])).toBeNull();
  });

  it("完全陌生的公司返回 null，不硬凑", () => {
    expect(matcher.match(["Totally Unrelated Beverage"])).toBeNull();
  });

  it("目录标签与 slug 差异很大时仍能靠 slug 命中", () => {
    expect(matcher.match(["One of One"])).toMatchObject({ slug: "one-of-one" });
  });
});
