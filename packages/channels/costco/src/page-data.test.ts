import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { costcoImages } from "./images.js";
import { costcoPrices } from "./commerce.js";

function documentWith(item = "648220") {
  const props = {
    selectedChildItemNumber: item,
    brandfolderAsset: [
      {
        attachments: {
          data: [
            {
              attributes: {
                cdn_url: "https://gdx-assets.costco.com/observed-original.jpg",
                mimetype: "image/jpeg",
              },
            },
          ],
        },
      },
    ],
    children: [
      "$",
      "$L2",
      null,
      {
        productDetailsData: {
          productData: { id: "100029983" },
          priceInfo: {
            displayPrice: { onlinePrice: 43.99, deliveredPrice: 35.99, warehouseNumber: "847" },
          },
        },
      },
    ],
  };
  const row = `a1:["$","$L1",null,${JSON.stringify(props)}]\n`;
  const split = Math.floor(row.length / 2);
  const scripts = [row.slice(0, split), row.slice(split)]
    .map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`)
    .join("");
  return parseHTML(`<html><body>${scripts}</body></html>`).document;
}
it("decodes split Flight chunks and selects only the item's observed original attachments", () => {
  const images = costcoImages(
    documentWith(),
    { sku: "648220", image: "https://gdx-assets.costco.com/preview.avif" },
    "https://www.costco.com/p/-/100029983",
  );
  expect(images).toEqual(["https://gdx-assets.costco.com/observed-original.jpg"]);
});
it("does not borrow another item's label or price data", () => {
  expect(
    costcoImages(documentWith("999"), { sku: "648220" }, "https://www.costco.com/p/-/100029983"),
  ).toEqual([]);
  expect(costcoPrices(documentWith(), "999")).toEqual([]);
});
it("preserves the labelled prices without treating online warehouse 847 as a selected retail store", () => {
  expect(costcoPrices(documentWith(), "100029983")).toEqual([
    {
      label: "Online Price",
      price: "43.99",
      text: "onlinePrice=43.99; warehouseNumber=847",
      source: "page-data",
    },
    {
      label: "Delivered Price",
      price: "35.99",
      text: "deliveredPrice=35.99; warehouseNumber=847",
      source: "page-data",
    },
  ]);
});
