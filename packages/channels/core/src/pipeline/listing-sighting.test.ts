import { describe, expect, it } from "vitest";
import { identitySighting } from "./listing-sighting.js";

describe("page-owned identity compared with the requested listing", () => {
  const requested = { listingId: "requested", variantId: null };

  it("reports a different listing with its own ID and retained original", () => {
    expect(
      identitySighting(requested, { listingId: "observed", variantId: null }, "original.html"),
    ).toMatchObject({
      state: "unlisted",
      reason: "identity_conflict",
      causeCode: "LISTING.IDENTITY_CONFLICT",
      requestedListingId: "requested",
      requestedVariantId: null,
      observedListingId: "observed",
      observedVariantId: null,
      archiveKey: "original.html",
    });
  });

  it("allows the page to select a variant when none was requested", () => {
    expect(
      identitySighting(requested, { ...requested, variantId: "selected" }, "original.html"),
    ).toBeNull();
  });

  it("allows the same explicitly requested variant", () => {
    const selected = { ...requested, variantId: "selected" };
    expect(identitySighting(selected, selected, "original.html")).toBeNull();
  });

  it("reports a different explicitly requested variant as an identity conflict", () => {
    expect(
      identitySighting(
        { ...requested, variantId: "requested-variant" },
        { ...requested, variantId: "observed-variant" },
        "original.html",
      ),
    ).toMatchObject({
      state: "unlisted",
      reason: "identity_conflict",
      requestedListingId: "requested",
      requestedVariantId: "requested-variant",
      observedListingId: "requested",
      observedVariantId: "observed-variant",
    });
  });
});
