import { describe, expect, it } from "vitest";
import { imageUrls, sectionImages } from "@crawl-automation/channels-core";
import { dtcDocument } from "./product.js";

const context = {
  url: "https://shop.example/products/chews",
  siteKey: "shop.example",
  imageOrigins: ["https://shop.example", "https://cdn.shopify.com"],
};
const hero = "/cdn/shop/files/hero.jpg?v=1";
const label = "/cdn/shop/files/facts.jpg?v=2";
const absolute = (url: string) => new URL(url, context.url).href;

function images(html: string) {
  return imageUrls(
    sectionImages(dtcDocument(`<main>${html}</main>`).querySelector("main")),
    context,
  );
}

describe("observed product image renditions", () => {
  it("replaces repeated sized heroes in place so the distinct facts image is next", () => {
    const result = images(`<img src="${hero}&width=990"
      srcset="${hero}&width=400 400w, ${hero}&width=800 800w, ${hero}&width=2068 2068w">
      <img src="${label}&width=800" data-srcset="${label}&width=1034 1034w">
      <img src="${hero}&width=600">`);
    expect(result).toEqual([absolute(`${hero}&width=2068`), absolute(`${label}&width=1034`)]);
  });

  it("reads density descriptors and both visible and lazy srcsets", () => {
    expect(
      images(`<img srcset="${hero}&width=400 1x, ${hero}&width=800 2x"
      data-srcset="${label}&width=400 1x, ${label}&width=1200 3x">`),
    ).toEqual([absolute(`${hero}&width=800`), absolute(`${label}&width=1200`)]);
  });

  it("preserves commas inside observed URLs", () => {
    const url = "/cdn/shop/files/facts,back.jpg?v=3&width=800";
    expect(images(`<img srcset="${url} 800w">`)).toEqual([absolute(url)]);
  });

  it("uses an observed original but never invents one by stripping the width", () => {
    expect(imageUrls([`${hero}&width=800`, hero, `${hero}&width=1600`], context)).toEqual([
      absolute(hero),
    ]);
    expect(imageUrls([`${hero}&width=800`, `${hero}&width=1600`], context)).toEqual([
      absolute(`${hero}&width=1600`),
    ]);
  });

  it("retains every different image, version, crop, height and unknown transformation", () => {
    const urls = [
      hero,
      label,
      "/cdn/shop/files/hero.jpg?v=2",
      `${hero}&crop=top&width=400`,
      `${hero}&crop=bottom&width=400`,
      `${hero}&height=400&width=400`,
      `${hero}&height=400&width=800`,
      `${hero}&format=jpg&width=400`,
      `${hero}&format=png&width=400`,
      `${hero}&label=old&width=400`,
      `${hero}&label=new&width=400`,
    ];
    expect(imageUrls(urls, context)).toEqual(urls.map(absolute));
  });

  it("keeps width parameters on unknown image providers independent", () => {
    const urls = ["/images/facts.jpg?width=400", "/images/facts.jpg?width=800"];
    expect(imageUrls(urls, context)).toEqual(urls.map(absolute));
  });

  it("compares query order without rewriting the selected URL", () => {
    const winner = "/cdn/shop/files/hero.jpg?width=1600&v=1";
    expect(imageUrls([`${hero}&width=400`, winner], context)).toEqual([absolute(winner)]);
  });

  it("supports the external Shopify CDN without merging it with another origin", () => {
    const cdn = "https://cdn.shopify.com/s/files/1/123/files/facts.jpg?v=1";
    expect(imageUrls([`${cdn}&width=400`, `${cdn}&width=1600`, hero], context)).toEqual([
      `${cdn}&width=1600`,
      absolute(hero),
    ]);
  });

  it.each(["0", "-1", "NaN", "Infinity", "10.5", "400&width=800"])(
    "does not interpret an ambiguous width %s as an original",
    (width) => {
      const urls = [`${hero}&width=${width}`, `${hero}&width=1600`];
      expect(imageUrls(urls, context)).toEqual(urls.map(absolute));
    },
  );

  it("preserves origin and recommendation exclusions", () => {
    expect(
      images(`<img src="${label}&width=800">
      <img src="https://foreign.example/cdn/shop/files/facts.jpg?width=1600">
      <product-recommendations><img src="${hero}&width=1600"></product-recommendations>`),
    ).toEqual([absolute(`${label}&width=800`)]);
  });

  it("applies the image limit to distinct candidates, while keeping the limit", () => {
    const sizes = Array.from({ length: 110 }, (_, index) => `${hero}&width=${index + 1}`);
    expect(imageUrls(sizes, context)).toEqual([absolute(`${hero}&width=110`)]);
    const distinct = sizes.map((_, index) => `/cdn/shop/files/${index}.jpg`);
    expect(() => imageUrls(distinct, context)).toThrowError(
      expect.objectContaining({ code: "DTC.PAGE_LIMIT" }),
    );
  });
});
