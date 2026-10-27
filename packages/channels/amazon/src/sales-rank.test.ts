import { describe, expect, it } from "vitest";
import { CommerceEvidenceSchema } from "@crawl-automation/v3-contracts";
import { amazonAdapter } from "./index.js";
import { amazonDocument } from "./dom.js";
import { amazonSalesRank } from "./sales-rank.js";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const samples = [
  { fixture: savedPage(savedPaths.fish, ""), rank: 5218, category: "Health & Household" },
  { fixture: savedPage(savedPaths.collagen, ""), rank: 64026, category: "Health & Household" },
];

for (const { fixture, rank, category } of samples) {
  it.skipIf(!fixture.available)(`${fixture.name}: root rank #${rank}`, () => {
    const page = fixture.read();
    const parsed = amazonAdapter.parseProduct(page);
    expect(parsed.identity.listingId).toBe(fixture.asin);
    const commerce = CommerceEvidenceSchema.parse(parsed.commerce);
    expect(commerce.salesRank).toMatchObject({
      rank,
      category,
      rawText: expect.stringContaining(`See Top 100 in ${category}`),
    });
    // The subcategory rank on the same row ("#12 in Fish Oil …") is never the root rank.
    expect(commerce.salesRank?.rank).not.toBeLessThan(100);
  });
}

describe("root rank wording", () => {
  const bullets = (inner: string) =>
    amazonDocument(
      `<html><body><div id="detailBullets_feature_div"><ul>${inner}</ul></div></body></html>`,
    );
  const row = (text: string) =>
    `<li><span class="a-list-item"><span class="a-text-bold"> Best Sellers Rank: </span> ${text}</span></li>`;

  it("reads the root rank with the See Top 100 marker and keeps the row text", () => {
    const document = bullets(
      row(
        `#1,234 in Health &amp; Household (<a href="/gp/bestsellers/hpc">See Top 100 in Health &amp; Household</a>) <ul><li>#12 in <a href="/x">Fish Oil Nutritional Supplements</a></li></ul>`,
      ),
    );
    expect(amazonSalesRank(document)).toEqual({
      rank: 1234,
      category: "Health & Household",
      rawText: expect.stringContaining(
        "#1,234 in Health & Household (See Top 100 in Health & Household)",
      ),
      selector: "#detailBullets_feature_div li",
    });
  });

  it("is null when only a subcategory rank is shown", () => {
    const document = bullets(row(`#12 in <a href="/x">Fish Oil Nutritional Supplements</a>`));
    expect(amazonSalesRank(document)).toBeNull();
  });

  it("is null when the two detail layouts disagree", () => {
    const document = amazonDocument(
      `<html><body><div id="detailBullets_feature_div"><ul>${row(
        `#1,234 in Health &amp; Household (See Top 100 in Health &amp; Household)`,
      )}</ul></div><div id="prodDetails"><table><tr><th>Best Sellers Rank</th><td>#9 in Beauty &amp; Personal Care (See Top 100 in Beauty &amp; Personal Care)</td></tr></table></div></body></html>`,
    );
    expect(amazonSalesRank(document)).toBeNull();
  });

  it("reads the table layout", () => {
    const document = amazonDocument(
      `<html><body><div id="prodDetails"><table><tr><th> Best Sellers Rank </th><td><ul><li><span>#64,026 in Health &amp; Household (<a href="/x">See Top 100 in Health &amp; Household</a>)</span></li><li>#588 in <a href="/y">Collagen Supplements</a></li></ul></td></tr></table></div></body></html>`,
    );
    expect(amazonSalesRank(document)).toMatchObject({ rank: 64026, selector: "#prodDetails tr" });
  });

  it("ignores other rows and a page without the block", () => {
    expect(
      amazonSalesRank(bullets(`<li><span class="a-text-bold">ASIN</span> B000</li>`)),
    ).toBeNull();
    expect(amazonSalesRank(amazonDocument("<html><body></body></html>"))).toBeNull();
  });
});
