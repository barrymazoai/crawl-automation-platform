import { describe, expect, it, vi } from "vitest";
import { guessBrandHosts, hostOf, resolveBrandSite, sameSite } from "./brand-site.js";

describe("guessBrandHosts", () => {
  it("连字符的两种写法都试——alani-nu 可能是 alaninu.com 也可能是 alani-nu.com", () => {
    expect(guessBrandHosts("alani-nu", "Alani Nu")).toEqual(expect.arrayContaining(["alaninu.com", "alani-nu.com"]));
  });
  it("展示名去掉商标符号后往往才是真域名", () => {
    expect(guessBrandHosts("kaged-muscle", "KAGED®")).toContain("kaged.com");
  });
  it("太短的词干不参与，避免乱撞", () => {
    expect(guessBrandHosts("ab", "AB")).toEqual([]);
  });
});

describe("resolveBrandSite", () => {
  it("跟随跳转，返回最终落地域名", async () => {
    const fetcher = vi.fn(async (host: string) =>
      host === "alaninu.com" ? { ok: true, finalUrl: "https://www.alanisnutrition.com/collections/all" } : null);
    await expect(resolveBrandSite("alani-nu", "Alani Nu", fetcher)).resolves.toEqual(
      { host: "alanisnutrition.com", probed: "alaninu.com" });
  });

  it("所有候选都不可达时如实返回 null，不猜", async () => {
    await expect(resolveBrandSite("made-up-brand", "Made Up", async () => null)).resolves.toEqual({ host: null, probed: null });
  });
});

describe("sameSite", () => {
  it("主域名相等才算同一家", () => {
    expect(sameSite("alaninu.com", "https://www.alaninu.com/pages/about")).toBe(true);
  });
  it("不做包含匹配——alaninu.com 与 nuhealth.com 无关", () => {
    expect(sameSite("alaninu.com", "https://nuhealth.com")).toBe(false);
  });
  it("刻意不剥行业词：basicvitamins 与 basicsupplements 是两家", () => {
    expect(sameSite("basicsupplements.com", "https://basicvitamins.com")).toBe(false);
  });
  it("任一边缺失就判否", () => {
    expect(sameSite(null, "https://x.com")).toBe(false);
    expect(sameSite("x.com", null)).toBe(false);
  });
});
