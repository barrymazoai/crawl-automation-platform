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

describe("剥词之后再判相等的陷阱", () => {
  const tricky = new BrandCatalogMatcher([
    { slug: "natures-lab", label: "Nature's Lab®" },
    { slug: "enzymedica", label: "Enzymedica®" },
    { slug: "daily-wellness-company", label: "Daily Wellness Company®" },
  ]);

  it("区分词恰好被剥掉时不匹配：Nature's Brands ≠ Nature's Lab", () => {
    // 两边剥完都只剩 natures，可真正区分它们的就是 Brands / Lab
    expect(tricky.match(["Nature's Brands"])).toBeNull();
    expect(tricky.match(["Nature's Health"])).toBeNull();
    expect(tricky.match(["Nature's Life"])).toBeNull();
    expect(tricky.match(["Daily Health, Inc."])).toBeNull();
  });

  it("一方只是多带了通用词时仍然匹配：Enzymedica Labs = Enzymedica", () => {
    expect(tricky.match(["Enzymedica Labs, Inc."])).toMatchObject({ slug: "enzymedica", tier: "strong" });
  });

  it("公司名恰好等于目录名时仍是 exact", () => {
    expect(tricky.match(["Nature's Lab"])).toMatchObject({ slug: "natures-lab", tier: "exact" });
  });
});
