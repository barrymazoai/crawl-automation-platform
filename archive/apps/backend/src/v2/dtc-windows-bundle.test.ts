import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWindowsBundle, recordToProducts } from "./dtc-capture.js";

/** 按 2026-09-02 liveowyn 真实包的结构造夹具：bundle.json + data/<n>-<variantId>.json + images/。 */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "win-bundle-"));
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.mkdir(path.join(dir, "images"), { recursive: true });
  await fs.writeFile(path.join(dir, "images", "aaaa.webp"), "img");
  await fs.writeFile(path.join(dir, "images", "bbbb.webp"), "img");
  await fs.writeFile(path.join(dir, "data", "000-54131015778668.json"), JSON.stringify({
    productUrl: "https://liveowyn.com/products/plant-based-kidz-chocolate-nutrition-shake",
    fields: {
      title: "Plant-Based Kidz Chocolate Nutrition Shake", description: "smooth, creamy", ingredients_text: "Pea protein, cocoa",
      images: ["https://cdn.shopify.com/a.png", "https://cdn.shopify.com/b.png"], sku: "OWYN-050770-1", price: "8.49", evidence_source: "shopify_http",
    },
    variant: { variantId: "54131015778668", sku: "OWYN-050770-1", title: "Carton / 4-Pack", options: { "Pack Unit Type": "Carton", Size: "4-Pack" }, price: "8.49", available: true, url: "https://liveowyn.com/products/plant-based-kidz-chocolate-nutrition-shake?variant=54131015778668" },
    capturedAt: "2026-09-02T08:05:50.454Z", evidenceSource: "shopify_http+worker_cdp",
  }));
  await fs.writeFile(path.join(dir, "bundle.json"), JSON.stringify({
    schemaVersion: "1.0", itemCount: 1,
    items: [{
      externalId: "54131015778668", productUrl: "https://liveowyn.com/products/plant-based-kidz-chocolate-nutrition-shake?variant=54131015778668",
      title: "Plant-Based Kidz Chocolate Nutrition Shake — Carton / 4-Pack", sku: "OWYN-050770-1", skuMissing: false,
      variant: { variantId: "54131015778668", sku: "OWYN-050770-1", options: { "Pack Unit Type": "Carton", Size: "4-Pack" }, price: "8.49", available: true },
      sourceFiles: ["data/entry.png", "data\\\\000-54131015778668.json"], imageFiles: ["images/aaaa.webp", "images/bbbb.webp"],
    }],
  }));
  return dir;
}

describe("Windows EvidenceBundleV1 → 产品", () => {
  it("bundle.json + data/*.json 能读出变体、字段、本地图片；ingredients_text 对齐成 ingredients", async () => {
    const dir = await fixture();
    const records = await readWindowsBundle(dir);
    expect(records).toHaveLength(1);
    const products = recordToProducts(records![0]!, dir, "2026-09-02T09:00:00.000Z");
    expect(products).toHaveLength(1);
    const p = products[0]!;
    expect(p.externalId).toBe("liveowyn.com:shopify_variant:54131015778668");
    expect(p.sku).toBe("OWYN-050770-1");
    expect(p.title).toContain("Plant-Based Kidz Chocolate Nutrition Shake");
    expect(p.price).toBe("8.49");
    expect(p.available).toBe(true);
    expect(p.variantOptions).toEqual({ "Pack Unit Type": "Carton", Size: "4-Pack" });
    expect(p.detailText).toContain("Pea protein");
    expect(p.images).toEqual(["https://cdn.shopify.com/a.png", "https://cdn.shopify.com/b.png"]);
    expect(p.localImages.map((f) => path.basename(f)).sort()).toEqual(["aaaa.webp", "bbbb.webp"]);
  });

  it("没有 bundle.json 的目录返回 null，让调用方继续走 harvest 格式", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "win-bundle-empty-"));
    expect(await readWindowsBundle(dir)).toBeNull();
  });
});

describe("Codex 拼的包路径写错时", () => {
  it("imageFiles 指向不存在的路径 → 按 files 清单/文件名找回；record.json 按内容识别", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "win-bundle-wrongpath-"));
    await fs.mkdir(path.join(dir, "capture", "img"), { recursive: true });
    await fs.mkdir(path.join(dir, "items", "abc"), { recursive: true });
    await fs.writeFile(path.join(dir, "capture", "img", "f0659bf6.webp"), "img");
    await fs.writeFile(path.join(dir, "items", "abc", "page-dom.txt"), "dom");
    await fs.writeFile(path.join(dir, "items", "abc", "record.json"), JSON.stringify({
      productUrl: "https://liveowyn.com/products/x", fields: { title: "X Shake", images: ["https://cdn/x.png"], sku: "X-1", price: "9.99" },
      variant: { variantId: "1", sku: "X-1", options: {}, price: "9.99", available: true },
    }));
    await fs.writeFile(path.join(dir, "bundle.json"), JSON.stringify({
      items: [{ externalId: "1", productUrl: "https://liveowyn.com/products/x?variant=1", title: "X Shake", sku: "X-1", skuMissing: false,
        variant: { variantId: "1", sku: "X-1", options: {}, price: "9.99", available: true },
        sourceFiles: ["items/abc/page-dom.txt", "items/abc/record.json"],
        imageFiles: ["capture/evidence/img/f0659bf6.webp", "capture/evidence/img/missing.webp"] }],
      files: [{ path: "capture/img/f0659bf6.webp", sha256: "x", byteSize: 3, mediaType: "image/webp" }],
    }));
    const products = recordToProducts((await readWindowsBundle(dir))![0]!, dir, "2026-09-02T09:00:00.000Z");
    expect(products).toHaveLength(1);
    expect(products[0]!.title).toBe("X Shake");
    expect(products[0]!.localImages).toEqual([path.join(dir, "capture", "img", "f0659bf6.webp")]);
  });
});

describe("页面 HTML 成分表接入", () => {
  it("record.pageHtml 指向包内 HTML → 抠出成分表进 htmlTable，指认的成分表图排在 imageRefs 最前", async () => {
    const { toDtcCapturedProduct } = await import("./dtc-capture.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "win-bundle-html-"));
    await fs.mkdir(path.join(dir, "html"), { recursive: true });
    await fs.writeFile(path.join(dir, "html", "p1.html"), `<html><body><h2>Supplement Facts</h2>
      <table><tr><td>Serving Size</td><td>1 Scoop (30 g)</td></tr><tr><td>Servings Per Container</td><td>30</td></tr>
      <tr><td>Vitamin C</td><td>90 mg</td><td>100%</td></tr><tr><td>Zinc</td><td>11 mg</td><td>100%</td></tr><tr><td>Protein</td><td>20 g</td><td>40%</td></tr></table>
      <img alt="front" src="https://cdn/x/front.png"><img alt="Supplement Facts label" src="https://cdn/x/label.png"></body></html>`);
    const record = { productUrl: "https://brand.example/products/p1", pageHtml: "html/p1.html",
      fields: { title: "P1", images: ["https://cdn/x/front.png", "https://cdn/x/label.png"], sku: "P1" }, gallery: [], variants: [] };
    const [product] = recordToProducts(record as any, dir, "2026-09-02T09:00:00.000Z");
    expect(product!.htmlFactsText).toContain("Vitamin C | 90 mg | 100%");
    expect(product!.factsImageUrls).toEqual(["https://cdn/x/label.png"]);
    const contract = toDtcCapturedProduct(product!);
    expect(contract.factsEvidence.htmlTable).toContain("HTML FACTS TABLE");
    expect(contract.factsEvidence.imageRefs).toEqual(["https://cdn/x/label.png", "https://cdn/x/front.png"]);
  });
});
