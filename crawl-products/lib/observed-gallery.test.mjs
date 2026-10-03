import { expect, it } from "vitest";
import { verifyObservedGallery } from "./observed-gallery.mjs";

function fixture() {
  const urls = ["https://shop.test/120.png", "https://shop.test/240.png", "https://shop.test/unknown.png"];
  return { base: { gallery: urls.map(url => ({ url })) }, context: {
    basis: "variant-state", galleryUrls: [urls[0]], galleryReview: urls.map((url, index) => ({
      url, status: ["applicable", "other-variant", "unresolved"][index],
      ...(index === 0 ? { basis: "visual-content" } : {}),
      reason: ["Package explicitly prints 120 capsules, matching the website option",
        "Package prints 240 capsules, a different website option", "Image contains no confirmed scope marking"][index],
      evidence: [`image-${index}.png`],
    })),
  } };
}

it("retains the full product gallery while isolating one variant's confirmed images", () => {
  const { base, context } = fixture();
  verifyObservedGallery(base, context);
  expect(base.gallery).toHaveLength(3);
});

it.each(["empty", "unreviewed", "duplicate", "other", "unknown", "visibility", "shared"])(
  "rejects %s gallery scope before collection and during host verification", failure => {
    const { base, context } = fixture();
    if (failure === "empty") context.galleryUrls = [];
    if (failure === "unreviewed") context.galleryReview.pop();
    if (failure === "duplicate") context.galleryReview[1] = context.galleryReview[0];
    if (failure === "other") context.galleryUrls.push(base.gallery[1].url);
    if (failure === "unknown") context.galleryUrls.push(base.gallery[2].url);
    if (failure === "visibility") context.galleryReview[0].basis = "variant-state";
    if (failure === "shared") context.galleryReview[0].basis = "website-shared";
    expect(() => verifyObservedGallery(base, context)).toThrow(/variant_gallery_/);
  },
);

it("does not treat a null website image binding as evidence of shared applicability", () => {
  const { base, context } = fixture();
  delete context.galleryReview;
  context.galleryUrls = base.gallery.map(image => image.url);
  base.gallery.forEach(image => { image.variantId = null; });
  expect(() => verifyObservedGallery(base, context)).toThrow("variant_gallery_review_incomplete");
});
