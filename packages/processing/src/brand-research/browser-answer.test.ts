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
      evidence: { quote: "Sprout makes nutritional supplements.", url: subject.brandUrl },
    }));
    const answer = checkFamilyAnswer(
      { ...family, shape: "shared_site", subBrands, archiveKeys: ["fabricated"] },
      archive(),
    );
    expect(answer.subBrands).toHaveLength(21);
    expect(answer.archiveKeys).toEqual(archive().archiveKeys);
  });
  it("links a cited clue to a published page and refuses unretained or invented quotations", () => {
    const pages = archive([page(subject.brandUrl), page(clue.url ?? "", clue.quote)]);
    const answer = checkFamilyAnswer({ ...family, clues: [clue] }, pages);
    expect(answer.clues[0]?.archiveKey).toBe(pages.pages[1]?.archiveKey);
    expect(() => checkFamilyAnswer({ ...family, clues: [clue] }, archive())).toThrow();
    expect(() =>
      checkFamilyAnswer({ ...family, clues: [{ ...clue, quote: "Unprinted claim" }] }, pages),
    ).toThrow();
  });
  it("requires the actual landing page and evidence for a cross-company redirect", () => {
    const redirected = {
      ...family,
      landedUrl: "https://garden.example/",
      redirect: { fromDomain: "sprout.example", toDomain: "garden.example", sameBrand: false },
    };
    expect(() => checkFamilyAnswer(redirected, archive())).toThrow();
    expect(() => checkFamilyAnswer(redirected, archive([page(redirected.landedUrl)]))).toThrow();
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
