import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dtcSitePolicy } from "../site-policy.js";
import { capturedProductProjection } from "./product-projection.js";
import type { HarvestRecord, CaptureReview } from "./product-record.js";
import { retainSiteMethod } from "./site-method.js";
import { retainedProductTitle } from "./product-title.js";

const corpus = new URL("../../../../../tools/diag-corpus/round9/trio/failed/", import.meta.url);
const url = "https://triomedica.com/products/health-and-wellness/wellness-booster-watermelon";
const available = existsSync(new URL("evidence/records.json", corpus));

function retained() {
  const [raw] = JSON.parse(readFileSync(new URL("evidence/records.json", corpus), "utf8"));
  const record = { ...raw, variants: raw.variants ?? [] } as HarvestRecord;
  const html = readFileSync(new URL("evidence/html/ad8d3d86ad272f08.html", corpus));
  const detailsHtml = readFileSync(new URL("materials/product-initial.html", corpus), "utf8");
  const imageAssignments = record.gallery.map((image) => ({
    url: image.url,
    variantId: null,
    basis: "product-gallery" as const,
  }));
  const review = {
    productUrl: url,
    selectedVariantId: null,
    galleryUrls: record.gallery.map((image) => image.url),
    galleryComplete: true,
    variantsComplete: true,
    detailComplete: true,
    method: "collector-completed-materials",
    surface: "local_file",
    verifier: "capture",
    evidence: ["materials/product-initial.html"],
    imageAssignments,
  } as CaptureReview;
  const site = dtcSitePolicy({ siteKey: "triomedica.com", platform: "custom", catalogUrl: url });
  return { record, html, detailsHtml, review, site, url };
}

it.skipIf(!available)(
  "uses the retained TrioMedica page title when the saved record omitted title",
  () => {
    const product = capturedProductProjection(retained());
    expect(product.evidence.title).toBe(
      "Wellness Booster (Watermelon) | Health and Wellness Supplements | Products | TrioMedica | An American Nutraceutical Company",
    );
    expect(product.evidence.warnings).toContain("DTC.TITLE_FROM_PAGE_OG_TITLE");
  },
);

it.skipIf(!available)(
  "returns coded Review when neither record nor retained page gives a title",
  () => {
    const input = retained();
    expect(() =>
      capturedProductProjection({
        ...input,
        html: Buffer.from("<html></html>"),
        detailsHtml: "<section></section>",
      }),
    ).toThrowError(expect.objectContaining({ code: "DTC.PRODUCT_TITLE_MISSING" }));
  },
);

it.skipIf(!available)("prefers the product region h1, then the page title", () => {
  const input = retained();
  expect(
    retainedProductTitle({ ...input, detailsHtml: "<section><h1>Scoped product</h1></section>" }),
  ).toEqual({ title: "Scoped product", source: "DTC.TITLE_FROM_PRODUCT_HTML_H1" });
  expect(
    retainedProductTitle({
      ...input,
      html: Buffer.from("<title>Page product</title>"),
      detailsHtml: "<section></section>",
    }),
  ).toEqual({ title: "Page product", source: "DTC.TITLE_FROM_PAGE_TITLE" });
});

it.skipIf(!available)("turns another invalid projection field into coded Review", () => {
  const input = retained();
  const first = input.review.imageAssignments[0];
  if (!first) {
    throw new Error("missing retained image assignment");
  }
  first.url = "invalid-url";
  expect(() => capturedProductProjection(input)).toThrowError(
    expect.objectContaining({ code: "DTC.CAPTURE_REVIEW" }),
  );
});

it.skipIf(!available)(
  "does not accept the title-less validating record as a reusable method",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-method-validation-")));
    const profileDir = join(root, "profiles");
    try {
      await mkdir(join(root, "evidence"));
      await mkdir(profileDir);
      const source = readFileSync(new URL("site-method.mjs", corpus));
      const sha256 = createHash("sha256").update(source).digest("hex");
      await writeFile(join(root, "site-method.mjs"), source);
      await writeFile(join(root, "method-use.json"), JSON.stringify({ sha256, productUrl: url }));
      await writeFile(
        join(root, "evidence/records.json"),
        readFileSync(new URL("evidence/records.json", corpus)),
      );
      expect(await retainSiteMethod({ profileDir, root, url })).toBeNull();
      expect(await readdir(profileDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps a missing title as a coded Review without local diagnostic files", () => {
  const record = {
    productUrl: url,
    fields: {},
    variants: [],
    flags: [],
    gallery: [],
    pageHtml: "page.html",
  } as HarvestRecord;
  expect(() => retainedProductTitle({ record, html: Buffer.from("<html></html>") })).toThrowError(
    expect.objectContaining({ code: "DTC.PRODUCT_TITLE_MISSING" }),
  );
});

it("rejects a title-less method receipt without local diagnostic files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-method-standalone-")));
  const profileDir = join(root, "profiles");
  try {
    await mkdir(join(root, "evidence"));
    await mkdir(profileDir);
    const source = Buffer.from("export async function capture() {}\n");
    const sha256 = createHash("sha256").update(source).digest("hex");
    await writeFile(join(root, "site-method.mjs"), source);
    await writeFile(join(root, "method-use.json"), JSON.stringify({ sha256, productUrl: url }));
    await writeFile(
      join(root, "evidence/records.json"),
      JSON.stringify([
        {
          productUrl: url,
          fields: {},
          gallery: [{ url: "https://triomedica.com/image.webp" }],
        },
      ]),
    );
    expect(await retainSiteMethod({ profileDir, root, url })).toBeNull();
    expect(await readdir(profileDir)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
