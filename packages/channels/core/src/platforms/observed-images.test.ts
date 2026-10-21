import { describe, expect, it } from "vitest";
import { imageUrls } from "./content.js";
import { observedImageSizes } from "./observed-images.js";

// sambucolusa.com Day & Night capsules, 2026-10-21: the product gallery plus the theme's thumbnails and placeholder.
const original =
  "https://cdn.shopify.com/s/files/1/2525/2958/files/89116001358_MAIN_IMAGE_Sambucol_DayNightCapsules_24ct_Front.png?v=1790801991";
const thumbnails = [86, 98, 172, 196, 258, 294].map(
  (width) =>
    `https://sambucolusa.com/cdn/shop/files/89116001358_MAIN_IMAGE_Sambucol_DayNightCapsules_24ct_Front_${width}x.png?v=1790801991`,
);
const placeholder =
  "https://sambucolusa.com/cdn/shop/t/26/assets/blank_1x1.gif?v=50849316544257392421695060391";
const context = {
  url: "https://sambucolusa.com/products/sambucol-black-elderberry-day-night-relief-capsules",
  siteKey: "sambucolusa.com",
  imageOrigins: ["https://sambucolusa.com", "https://cdn.shopify.com"],
};

describe("observedImageSizes", () => {
  it("collapses legacy width renditions under the shop host onto the CDN original", () => {
    expect(observedImageSizes([original, ...thumbnails])).toEqual([original]);
  });

  it("keeps the widest observed rendition when the original was not observed", () => {
    expect(observedImageSizes(thumbnails)).toEqual([thumbnails[5]]);
  });

  it("keeps a different version of the same file", () => {
    const newer = original.replace("v=1790801991", "v=1790801999");
    expect(observedImageSizes([original, newer])).toEqual([original, newer]);
  });
});

describe("imageUrls", () => {
  it("leaves theme assets out", () => {
    expect(imageUrls([original, placeholder, ...thumbnails], context)).toEqual([original]);
  });
});
