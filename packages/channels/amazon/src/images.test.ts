import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { amazonImages } from "./images.js";
import type { ScriptData } from "./script-data.js";

const hiRes = "https://m.media-amazon.com/images/I/hires._AC_SL1500_.jpg";
const large = "https://m.media-amazon.com/images/I/large._AC_SL500_.jpg";
const thumbnail = "https://m.media-amazon.com/images/I/thumb._AC_SL75_.jpg";

function images(galleries: unknown[], imageSize: number | null = null) {
  const root = parseHTML(
    `<div id="ppd"><div id="imageBlock"><img src="${thumbnail}"></div></div>`,
  ).document.querySelector("#ppd");
  if (!root) {
    throw new Error("Missing test product root");
  }
  const data: ScriptData = { galleries, families: [], warnings: [] };
  return amazonImages(root, data, imageSize).map((candidate) => candidate.url);
}

describe("Amazon selected gallery image resolution", () => {
  it("takes hiRes before large for each image", () => {
    expect(images([[{ hiRes, large }]])).toEqual([hiRes]);
  });

  it("keeps valid high-resolution items when a neighboring item is malformed", () => {
    expect(
      images([
        [
          { hiRes, large },
          { hiRes: 42, large: 12 },
        ],
      ]),
    ).toEqual([hiRes]);
  });

  it("uses a valid item's large image when hiRes is absent", () => {
    expect(images([[{ hiRes: null, large }, { hiRes: 42 }]])).toEqual([large]);
  });

  it("a storefront with an image size asks Amazon for the same image at that size (amazon.in, 2560 px)", () => {
    expect(images([[{ hiRes, large }], [{ hiRes: null, large }]], 2560)).toEqual([
      "https://m.media-amazon.com/images/I/hires._SL2560_.jpg",
      "https://m.media-amazon.com/images/I/large._SL2560_.jpg",
    ]);
    expect(images([[{ hiRes: "https://m.media-amazon.com/images/I/plain.png" }]], 2560)).toEqual([
      "https://m.media-amazon.com/images/I/plain._SL2560_.png",
    ]);
  });

  it("the US storefront keeps the page's own image URLs", () => {
    expect(images([[{ hiRes, large }]], null)).toEqual([hiRes]);
  });

  it("two renderings of one image become one image at the storefront's size", () => {
    expect(images([[{ hiRes }, { hiRes: large.replace("large", "hires") }]], 2560)).toEqual([
      "https://m.media-amazon.com/images/I/hires._SL2560_.jpg",
    ]);
  });
});
