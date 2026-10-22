import { describe, expect, it } from "vitest";
import { CommerceEvidenceSchema } from "@crawl-automation/v3-contracts";
import { amazonAdapter } from "./index.js";
import { amazonDocument } from "./dom.js";
import { amazonListingDate, parseAmazonDate } from "./listing-date.js";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const external = process.env["V3_AMAZON_DFA_DATA_DIR"];
const samples = [
  { fixture: savedPage(savedPaths.fish, ""), date: "2007-06-13", text: "June 13, 2007" },
  { fixture: savedPage(savedPaths.collagen, ""), date: "2025-12-19", text: "December 19, 2025" },
  {
    fixture: savedPage("us/B0FRQMSCGV.html", external),
    date: "2025-10-13",
    text: "October 13, 2025",
  },
  {
    fixture: savedPage("us/B07NQMLYMQ.html", external),
    date: "2019-02-14",
    text: "February 14, 2019",
  },
  { fixture: savedPage("us/B084P2MVRJ.html", external), date: "2016-05-19", text: "May 19, 2016" },
  { fixture: savedPage("pages/B0GR1L7J9J.html", external), date: null, text: null },
];

for (const { fixture, date, text } of samples) {
  it.skipIf(!fixture.available)(`${fixture.name}: DFA = ${date}`, () => {
    const page = fixture.read();
    const parsed = amazonAdapter.parseProduct(page);
    expect(parsed.identity.listingId).toBe(fixture.asin);
    const commerce = CommerceEvidenceSchema.parse(parsed.commerce);
    if (date === null) {
      expect(page.html).toContain('id="prodDetails"');
      expect(commerce.dateFirstAvailable).toBeNull();
    } else {
      expect(commerce.dateFirstAvailable).toMatchObject({
        date,
        rawText: expect.stringContaining(text),
      });
      const row = amazonDocument(page.html).querySelectorAll("#detailBullets_feature_div li");
      expect(
        [...row].some((item) => item.textContent === commerce.dateFirstAvailable?.rawText),
      ).toBe(true);
    }
  });
}

describe("strict calendar dates", () => {
  it.each([
    ["February 29, 2024", "2024-02-29"],
    ["June 3 2007", "2007-06-03"],
    ["\u200eOctober 13, 2025\u200f", "2025-10-13"],
    ["June 3, 07", null],
    ["Jun 3, 2007", null],
    ["June 3, 2007 extra", null],
    ["February 29, 2025", null],
    ["April 31, 2025", null],
    ["October 0, 2025", null],
    ["Unknown 1, 2025", null],
    ["2025-10-13", null],
    ["", null],
  ])("%s → %s", (raw, expected) => expect(parseAmazonDate(raw)).toBe(expected));
});

const fish = savedPage(savedPaths.fish, "");
it.skipIf(!fish.available)(
  "reads the same saved DFA row in the table layout (controlled DOM relocation)",
  () => {
    const document = amazonDocument(fish.read().html);
    const original = amazonListingDate(document);
    const item = [...document.querySelectorAll("#detailBullets_feature_div li")].find(
      (element) => element.textContent === original?.rawText,
    );
    expect(item).toBeDefined();
    const table = document.createElement("table");
    table.id = "prodDetails";
    const row = document.createElement("tr");
    const label = document.createElement("th");
    const value = document.createElement("td");
    label.textContent = item?.querySelector(".a-text-bold")?.textContent ?? "";
    value.textContent = item?.querySelector(".a-text-bold")?.nextElementSibling?.textContent ?? "";
    row.append(label, value);
    table.append(row);
    document.body.append(table);
    item?.remove();
    expect(amazonListingDate(document)).toEqual({
      date: "2007-06-13",
      rawText: row.textContent,
      selector: "#prodDetails tr",
    });
  },
);
