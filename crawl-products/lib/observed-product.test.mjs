import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { readObservedProduct, verifyObservedProduct } from "./observed-product.mjs";

const roots = [], url = "https://shop.test/products/travel-pack";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observed-product-"))); roots.push(root);
  const html = '<div class="description">Your cart is empty</div><div class="price">$49.98</div><main><h1>Travel Pack</h1><details class="detail"><summary>Description</summary><div class="body"><p>Multivitamin <strong>daily supply</strong>.</p><p>Keep this second paragraph.</p></div></details></main>';
  const json = JSON.stringify({ product: { id: 11, handle: "travel-pack", title: "Travel Pack", vendor: "Website brand", body_html: "<p>Actual product description.</p>", options: [{ name: "Supply" }], variants: [
    { id: 12, sku: "012", option1: "One Week", title: "One Week", price: "9.99", available: false },
    { id: 22, sku: "022", option1: "30 Day", title: "30 Day", price: "34.99", available: true },
  ] } });
  const sources = [];
  for (const [path, text, kind, sourceUrl] of [["page.html", html, "dom", url + "?variant=22"], ["product.json", json, "json", url + ".json"]]) {
    await writeFile(join(root, path), text);
    sources.push({ path, kind, url: sourceUrl, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return { root, method: { codec: "observed-product/1", productUrl: url, sources,
    fields: { title: { source: 1, pointer: "/product/title" }, brand: { source: 1, pointer: "/product/vendor" },
      description: { source: 0, selector: "main details.detail:first-of-type .body" } },
    platform: { kind: "shopify", source: 1, pointer: "/product" } } };
}

it("executes the observed full CSS location without fallback, retaining full text and website variants", async () => {
  const { root, method } = await fixture();
  const record = await readObservedProduct(root, method);
  expect(record.fields).toEqual({ title: "Travel Pack", brand: "Website brand", description: "Multivitamin daily supply . Keep this second paragraph." });
  expect(record.variants).toMatchObject([{ sku: "012", price: "9.99", available: false }, { sku: "022", price: "34.99", available: true }]);
  expect(record.fields.price).toBeUndefined();
  await verifyObservedProduct(root, record);
});

it.each(["missing", "ambiguous", "invalid"])("rejects a %s observed node without consulting whole-page text", async kind => {
  const { root, method } = await fixture();
  method.fields.description.selector = { missing: ".does-not-exist", ambiguous: "div", invalid: "[" }[kind];
  await expect(readObservedProduct(root, method)).rejects.toThrow(/DTC.OBSERVED_METHOD:/);
});

it.each(["value", "unmapped", "variant", "hash", "identity", "selected-state", "default-price"])("rejects %s contamination at handoff", async kind => {
  const { root, method } = await fixture();
  const record = await readObservedProduct(root, method);
  if (kind === "value") record.fields.description = "Your cart is empty";
  if (kind === "unmapped") record.fields.price = "$49.98";
  if (kind === "variant") record.variants[1].sku = "012";
  if (kind === "hash") await writeFile(join(root, "page.html"), "replacement");
  if (kind === "identity") method.sources[1].url = "https://other.test/products/travel-pack.json";
  if (kind === "selected-state") method.productUrl = url + "?variant=12";
  if (kind === "default-price") method.fields.price = { source: 1, pointer: "/product/variants/0/price" };
  await expect(verifyObservedProduct(root, record)).rejects.toThrow(/DTC.OBSERVED_METHOD:/);
});

it("uses the explicitly selected structured description, with no ingredient keyword interpretation", async () => {
  const { root, method } = await fixture();
  method.fields.description = { source: 1, pointer: "/product/body_html", format: "html-text" };
  const record = await readObservedProduct(root, method);
  expect(record.fields.description).toBe("Actual product description.");
  expect(Object.keys(record.fields).sort()).toEqual(["brand", "description", "title"]);
});

it("binds variant-specific fields to the requested website variant", async () => {
  const { root, method } = await fixture();
  method.productUrl = url + "?variant=22";
  method.fields.price = { source: 1, pointer: "/product/variants/1/price" };
  expect((await readObservedProduct(root, method)).fields.price).toBe("34.99");
  method.fields.price.pointer = "/product/variants/0/price";
  await expect(readObservedProduct(root, method)).rejects.toThrow("selected_variant_field");
});

it("requires an explicit availability source when platform JSON omits stock state", async () => {
  const { root, method } = await fixture();
  const { readFile } = await import("node:fs/promises");
  const product = JSON.parse(await readFile(join(root, "product.json"), "utf8"));
  for (const variant of product.product.variants) delete variant.available;
  const json = JSON.stringify(product);
  await writeFile(join(root, "product.json"), json);
  method.sources[1].sha256 = createHash("sha256").update(json).digest("hex");
  await expect(readObservedProduct(root, method)).rejects.toThrow("availability_source_required");
  const html = await readFile(join(root, "page.html"), "utf8") + '<script type="application/ld+json">' + JSON.stringify({
    "@type": "Product", url, offers: [
      { "@type": "Offer", url: url + "?variant=12", availability: "https://schema.org/OutOfStock" },
      { "@type": "Offer", url: url + "?variant=22", availability: "https://schema.org/InStock" },
    ],
  }) + '</script>';
  await writeFile(join(root, "page.html"), html);
  method.sources[0].sha256 = createHash("sha256").update(html).digest("hex");
  method.platform.offerSource = 0;
  expect((await readObservedProduct(root, method)).variants).toMatchObject([
    { variantId: "12", available: false, availability: "OutOfStock" },
    { variantId: "22", available: true, availability: "InStock" },
  ]);
});
