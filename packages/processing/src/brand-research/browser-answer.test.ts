import { describe, expect, it } from "vitest";
import { checkFamilyAnswer } from "./family-answer.js";
import { checkResearchAnswer } from "./research-answer.js";
import { archive, clue, family, page, research, subject } from "./fixtures.test-support.js";

describe("browser answers require retained citations", () => {
  it("uses host archive keys and does not impose the application's family limit", () => {
    const subBrands = Array.from({ length: 21 }, (_, index) => ({
      name: `Line ${index}`,
      url: null,
      isNutrition: false,
      evidence: { quote: `Line ${index} by Sprout`, url: subject.brandUrl },
    }));
    const pages = archive([
      page(subject.brandUrl, subBrands.map((brand) => brand.evidence.quote).join(". ")),
    ]);
    const answer = checkFamilyAnswer(
      { ...family, shape: "shared_site", subBrands, archiveKeys: ["fabricated"] },
      pages,
    );
    expect(answer.subBrands).toHaveLength(21);
    expect(answer.archiveKeys).toEqual(pages.archiveKeys);
  });
  it("gives an absorbed brand no sub-brands: the owner's brands are its siblings (MANTRA Labs)", () => {
    const quote = "Chapter One Gummies are attractive for children";
    const answer = checkFamilyAnswer(
      {
        ...family,
        landedUrl: "https://garden.example/",
        redirect: { fromDomain: "sprout.example", toDomain: "garden.example", sameBrand: false },
        shape: "shared_site",
        subBrands: [
          {
            name: "Chapter One",
            url: null,
            isNutrition: true,
            evidence: { quote, url: "https://garden.example/" },
          },
        ],
      },
      archive([page("https://garden.example/", quote)]),
    );
    expect(answer).toMatchObject({ shape: "single", subBrands: [] });
  });
  it("drops categories whose evidence does not name them (Kate Farms, 2026-10-09)", () => {
    const quote = "Daily nutrition for everyday enjoyment";
    const answer = checkFamilyAnswer(
      {
        ...family,
        shape: "shared_site",
        subBrands: [
          {
            name: "Everyday Adult",
            url: "https://shop.sprout.example/collections/everyday",
            isNutrition: true,
            evidence: { quote, url: subject.brandUrl },
          },
        ],
      },
      archive([page(subject.brandUrl, quote)]),
    );
    expect(answer).toMatchObject({ shape: "single", subBrands: [] });
  });
  it("links a cited clue to a published page and drops unretained or invented quotations", () => {
    const pages = archive([page(subject.brandUrl), page(clue.url ?? "", clue.quote)]);
    const answer = checkFamilyAnswer({ ...family, clues: [clue] }, pages);
    expect(answer.clues[0]?.archiveKey).toBe(pages.pages[1]?.archiveKey);
    // Owner 2026-10-09: an unverifiable clue is dropped; the rest of the answer is kept.
    expect(
      checkFamilyAnswer({ ...family, clues: [clue] }, archive([page(subject.brandUrl)])).clues,
    ).toEqual([]);
    expect(
      checkFamilyAnswer({ ...family, clues: [{ ...clue, quote: "Unprinted claim" }] }, pages).clues,
    ).toEqual([]);
  });
  it("requires the actual landing page and evidence for a cross-company redirect", () => {
    const redirected = {
      ...family,
      landedUrl: "https://garden.example/",
      redirect: { fromDomain: "sprout.example", toDomain: "garden.example", sameBrand: false },
    };
    expect(() => checkFamilyAnswer(redirected, archive())).toThrow();
    // The observed forward to a saved landing page is the evidence when Codex gave no usable clue.
    const observed = checkFamilyAnswer(redirected, archive([page(redirected.landedUrl)]));
    expect(observed.clues).toMatchObject([
      { signal: "domain_redirect", ownerDomain: "garden.example", url: redirected.landedUrl },
    ]);
    const redirectClue = { ...clue, signal: "domain_redirect", url: redirected.landedUrl };
    expect(
      checkFamilyAnswer(
        { ...redirected, clues: [redirectClue] },
        archive([page(redirected.landedUrl, clue.quote)]),
      ),
    ).toHaveProperty("redirect.sameBrand", false);
  });
  it("does not call a same-brand redirect ownership", () => {
    const redirect = {
      fromDomain: "old-sprout.example",
      toDomain: "sprout.example",
      sameBrand: true,
    };
    expect(checkFamilyAnswer({ ...family, redirect }, archive())).toHaveProperty(
      "redirect.sameBrand",
      true,
    );
    expect(() =>
      checkFamilyAnswer(
        { ...family, redirect, clues: [{ ...clue, signal: "domain_redirect" }] },
        archive([page(subject.brandUrl), page(clue.url ?? "", clue.quote)]),
      ),
    ).toThrow();
  });
  it("refuses redirect domains inconsistent with the saved landing page or the subject URL", () => {
    const redirect = {
      fromDomain: "old-sprout.example",
      toDomain: "wrong.example",
      sameBrand: true,
    };
    expect(() => checkFamilyAnswer({ ...family, redirect }, archive())).toThrow();
    expect(() =>
      checkFamilyAnswer(
        { ...family, redirect: { ...redirect, toDomain: "sprout.example" } },
        archive(),
        subject,
      ),
    ).toThrow();
  });
  it("replaces model timestamps with retained observation timestamps", () => {
    const answer = checkResearchAnswer(research, archive());
    expect(answer.evidence[0]?.observedAt).toBe(archive().pages[0]?.observedAt);
    expect(answer.archiveKeys).toEqual(archive().archiveKeys);
  });
  it.each([
    { checkedUrls: ["https://unvisited.example/"] },
    { category: "supplements" },
    { evidence: [] },
    { checkedUrls: [], clues: [] },
  ])("refuses unsupported research output", (change) => {
    expect(() => checkResearchAnswer({ ...research, ...change }, archive())).toThrow();
  });
  it.each(["Manufactured by Garden Group", "Distributed by Garden Group"])(
    "refuses maker-only clues",
    (quote) => {
      const observed = archive([page(subject.brandUrl, quote)]);
      expect(() =>
        checkResearchAnswer(
          {
            ...research,
            clues: [{ ...clue, signal: "website_footer", url: subject.brandUrl, quote }],
          },
          observed,
        ),
      ).toThrow();
    },
  );
});
