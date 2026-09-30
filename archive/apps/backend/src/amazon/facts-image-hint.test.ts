import { describe, expect, it } from "vitest";
import { extractProduct } from "./extract-product.js";

/** 页面指认成分表图 → 进 factsImageUrls；OCR 侧据此先跑这几张。 */
describe("Amazon 页面指认的成分表图", () => {
  const page = (imgs: string) => `<html><body><span id="productTitle">X</span>
    <div id="imageBlock">${imgs}</div></body></html>`;

  it("alt 或文件名标注为成分表的图会被指认出来，普通商品图不会", () => {
    const out = extractProduct(page(`
      <img alt="front of bottle" src="https://m.media-amazon.com/images/I/aaa.jpg">
      <img alt="Supplement Facts panel" src="https://m.media-amazon.com/images/I/bbb.jpg">
      <img alt="lifestyle" src="https://m.media-amazon.com/images/I/nutrition-label-ccc.jpg">
    `));
    expect(out.factsImageUrls).toEqual([
      "https://m.media-amazon.com/images/I/bbb.jpg",
      "https://m.media-amazon.com/images/I/nutrition-label-ccc.jpg",
    ]);
  });

  it("没有指认时为空数组，走原来的全画廊 OCR", () => {
    const out = extractProduct(page(`<img alt="front" src="https://m.media-amazon.com/images/I/aaa.jpg">`));
    expect(out.factsImageUrls).toEqual([]);
  });
});
