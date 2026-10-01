import { describe, expect, it } from "vitest";
import { amazonAdapter } from "./adapter.js";

const premium =
  '<div id="premiumBylineInfo_feature_div"><div class="a-section">' +
  '<div data-csa-c-slot-id="premium-logo-byline-link"><div>' +
  '<a id="visitStoreDesktopUrl" href="/stores/Example/page/store">' +
  "Visit the Example Store</a></div></div></div></div>";
const parse = (content: string, information = "") =>
  amazonAdapter.parseProduct({
    url: "https://www.amazon.com/dp/B002CQU532",
    capturedAt: "2026-10-01T00:00:00.000Z",
    html:
      '<div id="ppd"><div id="centerCol">' +
      '<div id="title_feature_div" data-csa-c-asin="B002CQU532">' +
      '<span id="productTitle">Example supplement</span></div>' +
      `${content}</div></div>${information}`,
  });

describe("premium product byline", () => {
  it("reads the product's premium store-link label", () => {
    expect(parse(premium).evidence.brandRaw).toBe("Example");
  });

  it("keeps the standard byline first", () => {
    expect(parse('<a id="bylineInfo">Brand: Original</a>' + premium).evidence.brandRaw).toBe(
      "Original",
    );
  });

  it("does not infer a brand from the title, recommendations or an arbitrary link", () => {
    expect(parse("").evidence.brandRaw).toBeNull();
    expect(parse(`<div id="recommendations">${premium}</div>`).evidence.brandRaw).toBeNull();
    expect(
      parse(premium.replace("Visit the Example Store", "A seller")).evidence.brandRaw,
    ).toBeNull();
  });
});

describe("bold information labels", () => {
  it("retains ingredients from a bold span in the product information block", () => {
    const parsed = parse(
      premium,
      '<div id="important-information"><h2>Important information</h2>' +
        '<div class="a-section content"><span class="a-text-bold">Ingredients</span>' +
        "<p></p><p>Organic Mushroom and Botanical Blend</p><p></p></div>" +
        '<div class="a-section content"><span class="a-text-bold">Legal Disclaimer</span>' +
        "<p>Not intended to diagnose any disease.</p></div></div>",
    );
    expect(parsed.facts.text).toContain("Organic Mushroom and Botanical Blend");
    expect(parsed.facts.text).not.toMatch(/Legal Disclaimer|diagnose/);
    expect(parsed.facts.complete).toBe(false);
    expect(parsed.facts.missing).toContain("AMAZON.FACTS_LABEL_MISSING");
    expect(parsed.evidence.factsCandidates).toHaveLength(1);
  });

  it("stops at the next bold label even within one content block", () => {
    const parsed = parse(
      "",
      '<div id="important-information"><div class="content">' +
        '<span class="a-text-bold">Ingredients</span><p>Cellulose</p>' +
        '<span class="a-text-bold">Directions</span><p>Take daily.</p></div></div>',
    );
    expect(parsed.facts.text).toContain("Cellulose");
    expect(parsed.facts.text).not.toMatch(/Directions|daily/);
  });

  it("ignores bold ingredient labels outside the product's information sections", () => {
    const unrelated =
      '<span class="a-text-bold">Ingredients</span><p>Other product ingredients</p>';
    const parsed = parse(
      "",
      unrelated +
        '<div id="important-information"><div id="recommendations"><div class="content">' +
        `${unrelated}</div></div></div>`,
    );
    expect(parsed.facts.text).toBeNull();
  });
});
