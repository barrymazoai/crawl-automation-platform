import { ChannelRegistry } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import { fakeAdapter } from "../history/listing-test-helpers.js";
import { FormulaLookup, formulaFamilies } from "./formula-lookup.js";

describe("formulaFamilies", () => {
  const registry = new ChannelRegistry([
    fakeAdapter({ id: "wholefoods", formulaFamily: "asin" }),
    fakeAdapter({ id: "gnc" }),
    fakeAdapter({ id: "amazon", formulaFamily: "asin" }),
    fakeAdapter({ id: "swanson", formulaFamily: "swanson" }),
  ]);

  it("returns only family members, sorted independently of registration order", () => {
    expect(formulaFamilies(registry).channels("wholefoods")).toEqual(["amazon", "wholefoods"]);
  });

  it.each(["gnc", "swanson", "unregistered"])(
    "does not share formulas outside %s's family",
    (channel) => {
      expect(formulaFamilies(registry).channels(channel)).toEqual([channel]);
    },
  );
});

describe("FormulaLookup.findKnown", () => {
  it.each([null, { operationId: "formula-operation" }])(
    "preserves an index answer %j and variant identity",
    async (answer) => {
      const families = { channels: vi.fn(() => ["amazon", "wholefoods"]) };
      const findKnown = vi.fn(async () => answer);
      const key = { channel: "wholefoods" as const, listingId: "asin", variantId: "size-two" };
      expect(await new FormulaLookup({ findKnown }, families).findKnown(key)).toBe(answer);
      expect(families.channels).toHaveBeenCalledExactlyOnceWith("wholefoods");
      expect(findKnown).toHaveBeenCalledExactlyOnceWith({
        channels: ["amazon", "wholefoods"],
        listingId: "asin",
        variantId: "size-two",
      });
    },
  );

  it("propagates index errors without broadening the search or retrying", async () => {
    const failure = new Error("index unavailable");
    const findKnown = vi.fn().mockRejectedValue(failure);
    const families = { channels: vi.fn(() => ["gnc"]) };
    const key = { channel: "gnc" as const, listingId: "listing", variantId: null };
    await expect(new FormulaLookup({ findKnown }, families).findKnown(key)).rejects.toBe(failure);
    expect(findKnown).toHaveBeenCalledOnce();
  });
});
