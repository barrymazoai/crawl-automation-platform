import { describe, expect, it } from "vitest";
import { assessEvidence, domainRelation, domainRoot, isCorroborated, profileMentions } from "./evidence.js";

describe("domainRoot", () => {
  it("取出域名主体，忽略 www 与后缀", () => {
    expect(domainRoot("https://www.alaninu.com")).toBe("alaninu");
    expect(domainRoot("basic-supplements.com")).toBe("basicsupplements");
    expect(domainRoot("https://shop.myprotein.co.uk")).toBe("myprotein");
  });
  it("拿不到域名时返回 null，不猜", () => {
    expect(domainRoot(null)).toBeNull();
    expect(domainRoot("不是网址")).toBeNull();
  });
});

describe("domainRelation", () => {
  it("域名与品牌 slug 一致即确证", () => {
    expect(domainRelation("alaninu", "alani-nu", "Alani Nu")).toBe("exact");
    expect(domainRelation("basicsupplements", "basic-supplements", "Basic Supplements")).toBe("exact");
  });

  it("绝不剥掉行业词再比较——那正是名字匹配栽过的坑", () => {
    // basicvitamins 与 basicsupplements 剥完都只剩 basic，却是两家不同公司
    expect(domainRelation("basicvitamins", "basic-supplements", "Basic Supplements")).toBe("none");
    expect(domainRelation("naturesbounty", "natures-lab", "Nature's Lab")).toBe("none");
  });

  it("完全不相干的域名判为无关", () => {
    expect(domainRelation("alphaflow", "flow-supplements", "Flow Supplements")).toBe("none");
    expect(domainRelation("newvigor", "vitalast", "Vitalast")).toBe("none");
  });
});

describe("profileMentions", () => {
  it("简介里出现品牌名即算一条独立证据", () => {
    expect(profileMentions("Maker of the True Strength line, Optimum Nutrition", "optimum-nutrition", "OPTIMUM NUTRITION")).toBe(true);
  });
  it("太短的品牌名不参与，避免误命中", () => {
    expect(profileMentions("A big company", "abe", "ABE")).toBe(false);
  });
});

describe("assessEvidence", () => {
  it("域名确证的可以直接放行", () => {
    const result = assessEvidence({ website: "https://alaninu.com", profile: "" }, "alani-nu", "Alani Nu");
    expect(result.corroboration).toBe("domain_exact");
    expect(isCorroborated(result)).toBe(true);
  });

  it("域名部分吻合但简介也提到，同样算确证", () => {
    const result = assessEvidence(
      { website: "https://sportsresearchlabs.com", profile: "We make Sports Research supplements" },
      "sports-research", "Sports Research");
    expect(isCorroborated(result)).toBe(true);
  });

  it("域名部分吻合、简介没提到——只算部分，仍要人工看", () => {
    const result = assessEvidence({ website: "https://sportsresearchlabs.com", profile: "" }, "sports-research", "Sports Research");
    expect(result.corroboration).toBe("domain_partial");
    expect(isCorroborated(result)).toBe(false);
  });

  it("两条证据都没有的一律不放行", () => {
    const result = assessEvidence({ website: "https://alphaflow.com", profile: "Alpha Flow makes drinks" }, "flow-supplements", "Flow Supplements");
    expect(result.corroboration).toBe("none");
    expect(isCorroborated(result)).toBe(false);
  });
});
