import { mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { readObservedProduct } from "./observed-product.mjs";
import { readObservedVariant } from "./observed-variant.mjs";

const roots = [];
const url = "https://shop.test/products/pack";
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "variant-preview-"))); roots.push(root);
  const html = '<main><input name="id" value="22"><p class="details">Observed selected package</p></main>';
  const json = JSON.stringify({ product: {
    id: 99, handle: "pack", title: "Daily Pack", vendor: "Website brand", options: ["Supply"],
    shared: "The listed product details apply to both One Week and 30 Day packages.",
    variants: [
      { id: 12, title: "One Week", option1: "One Week", sku: "012", price: "9.99", available: false },
      { id: 22, title: "30 Day", option1: "30 Day", sku: "022", price: "34.99", available: true },
    ],
  } });
  const sources = [];
  for (const [path, text, kind, sourceUrl] of [
    ["details.html", html, "dom", url + "?selling_plan=1&variant=22"],
    ["product.json", json, "json", url + ".json"],
  ]) {
    await writeFile(join(root, path), text);
    sources.push({ path, kind, url: sourceUrl, sha256: createHash("sha256").update(text).digest("hex") });
  }
  const method = {
    codec: "observed-product/1", productUrl: url, sources,
    fields: { title: { source: 1, pointer: "/product/title" }, brand: { source: 1, pointer: "/product/vendor" },
      description: { source: 0, selector: "main .details" } },
    platform: { kind: "shopify", source: 1, pointer: "/product" },
  };
  return { root, method, base: await readObservedProduct(root, method), html };
}

it("identifies a base method incorrectly reused as either selected state before harvest", async () => {
  const { root, method, base } = await fixture();
  for (const variantId of ["12", "22"]) {
    await expect(readObservedVariant(root, base, { status: "observed", basis: "variant-state", variantId }, method))
      .rejects.toThrow("variant_method_requires_selected_url");
  }
});

it("reuses the actual current-state original under a distinct method without changing the base or any file", async () => {
  const { root, method, base, html } = await fixture();
  const selectedMethod = { ...method, productUrl: method.sources[0].url };
  const observed = await readObservedVariant(root, base,
    { status: "observed", basis: "variant-state", variantId: "22" }, selectedMethod);
  expect(observed.variants).toEqual(base.variants);
  expect(observed.fields).toEqual(base.fields);
  expect(method.productUrl).toBe(url);
  expect(await readFile(join(root, "details.html"), "utf8")).toBe(html);
});

it("refuses to relabel the current state as the other option", async () => {
  const { root, method, base } = await fixture();
  await expect(readObservedVariant(root, base, { status: "observed", basis: "variant-state", variantId: "12" },
    { ...method, productUrl: url + "?variant=12" })).rejects.toThrow("source_variant");
  await expect(readObservedVariant(root, base, { status: "observed", basis: "variant-state", variantId: "12" },
    { ...method, productUrl: method.sources[0].url })).rejects.toThrow("variant_source_selected_conflict");
});

it("rejects changed website inventory and invented or duplicate identities", async () => {
  const { root, method, base } = await fixture();
  const selectedMethod = { ...method, productUrl: method.sources[0].url };
  const context = { status: "observed", basis: "variant-state", variantId: "22" };
  await expect(readObservedVariant(root, { ...base, variants: base.variants.slice(1) }, context, selectedMethod))
    .rejects.toThrow("variant_inventory_changed");
  await expect(readObservedVariant(root, base, { ...context, variantId: "99" }, selectedMethod))
    .rejects.toThrow("variant_identity_missing_or_duplicate");
  await expect(readObservedVariant(root, { ...base, variants: [...base.variants, base.variants[1]] }, context, selectedMethod))
    .rejects.toThrow("variant_identity_missing_or_duplicate");
});

it("requires the same exact shared website statement as the host", async () => {
  const { root, method, base } = await fixture();
  const context = { status: "observed", basis: "website-shared", variantId: "12" };
  await expect(readObservedVariant(root, base, context, method)).rejects.toThrow("variant_shared_scope_statement_required");
  context.sharedScope = { rule: { source: 1, pointer: "/product/shared" },
    text: "The listed product details apply to both One Week and 30 Day packages." };
  expect((await readObservedVariant(root, base, context, method)).variants).toEqual(base.variants);
  context.sharedScope.text = "Invented common formula";
  await expect(readObservedVariant(root, base, context, method)).rejects.toThrow("variant_shared_scope_statement_mismatch");
});
