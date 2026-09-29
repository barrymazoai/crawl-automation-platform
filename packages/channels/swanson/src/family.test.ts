import type { ParsedProduct } from "@crawl-automation/channels-core";
import type { SwansonRenderedProduct } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { swansonFamily } from "./family.js";

type Picker = NonNullable<SwansonRenderedProduct["variantPicker"]>;
const base = "https://www.swansonvitamins.com/p";

function option(handle: string, label: string, choice: { selected: boolean; group?: string }) {
  const { selected, group = "Size" } = choice;
  return {
    group,
    label,
    url: `${base}/${handle}`,
    variantId: String(handle.length),
    selected,
    available: true,
  };
}

/** The family reads only the page's option picker, so the test gives only that part of the parsed page. */
const parsedWith = (picker: Picker | undefined) =>
  ({ rendered: { variantPicker: picker } }) as unknown as ParsedProduct<SwansonRenderedProduct>;

describe("Swanson product family", () => {
  it("reads the other sizes from the option picker", () => {
    const picker = {
      unmapped: 0,
      options: [
        option("ho-ribose-10-oz", "10.6 oz Pwdr", { selected: true }),
        option("ho-ribose-21-oz", "21.2 oz Pwdr", { selected: false }),
      ],
    };
    expect(swansonFamily(parsedWith(picker))).toEqual({
      differsBy: "size",
      group: "Size",
      selectedLabel: "10.6 oz Pwdr",
      members: [
        {
          listingId: "ho-ribose-21-oz",
          variantId: "15",
          url: `${base}/ho-ribose-21-oz`,
          label: "21.2 oz Pwdr",
        },
      ],
    });
  });

  it("names a flavour family as such", () => {
    const picker = {
      unmapped: 0,
      options: [
        option("whey-choc", "Chocolate", { selected: true, group: "Flavor" }),
        option("whey-van", "Vanilla", { selected: false, group: "Flavor" }),
      ],
    };
    expect(swansonFamily(parsedWith(picker))?.differsBy).toBe("flavour");
  });

  it("reads no family when the picker is absent, partial or unclear", () => {
    expect(swansonFamily(parsedWith(undefined))).toBeNull();
    expect(swansonFamily(parsedWith({ unmapped: 0, options: [] }))).toBeNull();
    const unmapped = {
      unmapped: 1,
      options: [
        option("a-60", "60 Caps", { selected: true }),
        option("a-120", "120 Caps", { selected: false }),
      ],
    };
    expect(swansonFamily(parsedWith(unmapped))).toBeNull();
    const twoGroups = {
      unmapped: 0,
      options: [
        option("a-60", "60 Caps", { selected: true }),
        option("a-choc", "Chocolate", { selected: false, group: "Flavor" }),
      ],
    };
    expect(swansonFamily(parsedWith(twoGroups))).toBeNull();
  });
});
