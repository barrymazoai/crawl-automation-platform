import { deepEqual } from "node:assert/strict";
import { rejects } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { missingSiteMethodFields, repeatedSiteMethodIds,
  repeatedSiteMethodMaterialIds } from "./site-method-record.mjs";
import { runSiteCapture } from "./site-capture.mjs";

const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");

test("a learned product method needs title, matching URL and usable material", () => {
  const url = "https://example.com/products/a";
  const record = { sourceUrl: url, fields: { title: "A" } };
  deepEqual(missingSiteMethodFields(record, url, ["https://example.com/a.webp"]), []);
  deepEqual(missingSiteMethodFields({ ...record, fields: {} }, url, ["https://example.com/a.webp"]), ["title"]);
  deepEqual(missingSiteMethodFields(record, `${url}-other`, []), ["productUrl", "gallery_or_facts"]);
});

test("a saved region cannot append an element unique on the full page twice", () => {
  const root = new URL("../../tools/diag-corpus/round9/dherbs-dup/", import.meta.url);
  const region = readFileSync(new URL("legacy-product.html", root), "utf8");
  const page = readFileSync(new URL("legacy-page.html", root), "utf8");
  const ids = repeatedSiteMethodIds(region, page);
  deepEqual(ids, ["accordionFlushExample", "flush-headingOne", "flush-collapseOne",
    "flush-headingThree", "flush-collapseThree", "flush-headingTwo", "flush-collapseTwo"]);
  const { document } = parseHTML(region);
  document.querySelectorAll("#accordionFlushExample")[1].remove();
  deepEqual(repeatedSiteMethodIds(document.toString(), page), []);
});

test("legitimate site duplicates do not block a product or variant region", async () => {
  const files = new Map([
    ["base.html", '<div id="same"></div><div id="same"></div>'],
    ["page.html", '<main><div id="same"></div><div id="same"></div></main>'],
    ["variant.html", '<div id="unique"></div><div id="unique"></div>'],
    ["variant-page.html", '<main><div id="unique"></div></main>'],
  ]);
  const materials = { productHtml: "base.html", variants: [{ variantId: "v1",
    productHtml: "variant.html", pageHtml: "variant-page.html" }] };
  const gaps = await repeatedSiteMethodMaterialIds(materials, { pageHtml: "page.html" }, {},
    async path => files.get(path));
  deepEqual(gaps, [{ scope: "variant:v1", ids: ["unique"] }]);
});

test("capture reports repeated IDs before harvest writes a checkpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dtc-site-method-"));
  const outDir = join(cwd, "capture");
  const methodPath = join(cwd, "site-method.mjs");
  try {
    await mkdir(outDir);
    await writeFile(methodPath, `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function capture({ productUrl, outDir }) {
  await writeFile(join(outDir, "page.html"), '<main><section id="overview">A</section></main>');
  await writeFile(join(outDir, "product.html"),
    '<section id="overview">A</section><section id="overview">A</section>');
  return { record: { sourceUrl: productUrl, fields: { title: "A" }, variants: [] },
    galleryUrls: ["https://example.com/a.webp"],
    materials: { selectedVariantId: null, productHtml: "product.html", variants: [] },
    notes: { pageHtml: "page.html" } };
}`);
    const input = { cwd, outDir, methodPath, productUrl: "https://example.com/a",
      taskSpaceId: 1, label: "product", targetId: "target" };
    const globals = { taskSpace: async () => ({ page: async () => ({ targetId: "target" }) }),
      listTaskSpaces: async () => [] };
    await rejects(runSiteCapture(input, globals), /site_method_product_html_repeated_ids:.*overview/);
    deepEqual((await readdir(outDir)).sort(), ["page.html", "product.html"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
