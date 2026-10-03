/* eslint max-lines: ["error", 400], max-lines-per-function: "off" -- Shared test-only fixture extracted from variant-handoffs.test.ts; retain the test-file limits for declarative website originals. */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RetainedPublication, sha256, type ObjectStore } from "@crawl-automation/platform";
import { ProductSourcePlans } from "@crawl-automation/channels-core";
import { readObservedProduct } from "../../../../../crawl-products/lib/observed-product.mjs";
import { capturedProductProjection } from "./product-projection.js";
import { DtcVariantHandoffs } from "./variant-handoffs.js";
import { CaptureReviewSchema } from "./product-review.js";
import type { CaptureFile } from "./archive.js";
import type { HarvestRecord } from "./product-record.js";
import { createDtcAdapter } from "../adapter.js";
import { dtcSitePolicy } from "../site-policy.js";
import type { ObservedVariantContext } from "./variant-review.js";

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Synthetic website originals for offline isolation tests; no browser/network/model. */
export async function variantCaptureFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-variants-")));
  const data = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, bytes);
      return "created";
    },
  };
  const publication = new RetainedPublication(store, store);
  const files: CaptureFile[] = [];
  async function save(path: string, text: string) {
    const bytes = Buffer.from(text);
    await writeFile(join(root, path), bytes);
    const file = {
      path,
      objectKey: `original/${path}`,
      sha256: sha256(bytes),
      byteSize: bytes.length,
      mediaType: "application/octet-stream",
    };
    files.push(file);
    data.set(file.objectKey, bytes);
    return file;
  }
  const url = "https://shop.example/products/zinc";
  const json = await save(
    "product.json",
    JSON.stringify({
      product: {
        id: 99,
        handle: "zinc",
        title: "Zinc",
        vendor: "Actual Brand",
        body_html: "Website base description",
        shared_scope: "These product details and the shared gallery apply to Orange and Berry.",
        options: ["Flavour"],
        variants: [
          {
            id: 1,
            title: "Orange",
            option1: "Orange",
            sku: "ORANGE",
            price: "9.99",
            available: false,
          },
          {
            id: 2,
            title: "Berry",
            option1: "Berry",
            sku: "BERRY",
            price: "34.99",
            available: true,
          },
        ],
      },
    }),
  );
  const source = { path: json.path, sha256: json.sha256, kind: "json", url: `${url}.json` };
  const baseMethod = {
    codec: "observed-product/1",
    productUrl: url,
    sources: [source],
    fields: {
      title: { source: 0, pointer: "/product/title" },
      brand: { source: 0, pointer: "/product/vendor" },
      description: { source: 0, pointer: "/product/body_html" },
    },
    platform: { kind: "shopify", source: 0, pointer: "/product" },
  };
  await save("base-method.json", JSON.stringify(baseMethod));
  const contexts: ObservedVariantContext[] = [];
  const gallery = [];
  for (const id of ["1", "2"]) {
    const variantUrl = `${url}?variant=${id}`;
    const dom = await save(
      `variant-${id}.html`,
      `<main><p class="ingredients">${id === "1" ? "Orange peel" : "Berry extract"}</p></main>`,
    );
    const method = {
      ...baseMethod,
      productUrl: variantUrl,
      sources: [source, { path: dom.path, sha256: dom.sha256, kind: "dom", url: variantUrl }],
      fields: { ...baseMethod.fields, ingredients: { source: 1, selector: "main .ingredients" } },
    };
    await save(`method-${id}.json`, JSON.stringify(method));
    await save(`image-${id}.png`, `retained-image-${id}`);
    const imageUrl = `https://shop.example/gallery/${id}.png`;
    gallery.push({ url: imageUrl, localPath: `image-${id}.png`, mime: "image/png" });
    contexts.push({
      variantId: id,
      status: "observed",
      methodPath: `method-${id}.json`,
      galleryUrls: [imageUrl],
      galleryReview: [],
      basis: "variant-state",
      reason: "Observed website option and associated details",
      evidence: [dom.path],
      difference: { kind: "flavour", group: "Flavour" },
    });
  }
  const record: HarvestRecord = {
    ...(await readObservedProduct(root, baseMethod)),
    productUrl: url,
    variants: [],
    pageHtml: "variant-1.html",
    flags: [],
    gallery,
  };
  record.variants = (await readObservedProduct(root, baseMethod)).variants;
  const review = CaptureReviewSchema.parse({
    productUrl: url,
    selectedVariantId: "1",
    galleryUrls: gallery.map((image) => image.url),
    galleryComplete: true,
    variantsComplete: true,
    detailComplete: true,
    method: "Observed both options",
    surface: "local_file",
    verifier: "codex",
    evidence: ["variant-1.html", "variant-2.html"],
    variantContexts: contexts,
    imageAssignments: gallery.map((image, index) => ({
      url: image.url,
      variantId: String(index + 1),
      basis: "variant-featured",
    })),
  });
  for (const context of contexts) {
    Object.assign(context, {
      galleryReview: gallery.map((image, index) => ({
        url: image.url,
        status: context.galleryUrls.includes(image.url) ? "applicable" : "other-variant",
        basis: "visual-content",
        reason: `Observed package text identifies website flavour ${index === 0 ? "Orange" : "Berry"}`,
        evidence: [image.localPath],
      })),
    });
  }
  review.variantContexts = contexts;
  async function preflight() {
    const entries = (review.variantContexts ?? []).filter(
      (value): value is (typeof contexts)[number] =>
        !!value &&
        typeof value === "object" &&
        "status" in value &&
        ["observed", "mixed"].includes(String(value.status)),
    );
    const previous = files.findIndex((file) => file.path === "variant-preflight.json");
    if (previous !== -1) {
      files.splice(previous, 1);
    }
    await save(
      "variant-preflight.json",
      JSON.stringify({
        contexts: entries.map((context) => ({
          context,
          method: JSON.parse(
            Buffer.from(data.get(`original/${context.methodPath}`) ?? []).toString(),
          ),
          passed: true,
        })),
      }),
    );
  }
  await preflight();
  const site = dtcSitePolicy({
    siteKey: "shop.example",
    platform: "shopify",
    catalogUrl: "https://shop.example/collections/all",
  });
  const parsed = capturedProductProjection({ record, review, url, site });
  const planning = createDtcAdapter([site]).planning;
  if (!planning) {
    throw new Error("fixture requires planning");
  }
  const compat = {
    schemaVersion: 1 as const,
    implementationVersion: "test/1",
    policyVersion: "test/1",
    resultSchemaVersion: 2 as const,
    configFingerprint: "a".repeat(64),
  };
  const sourcePlans = new ProductSourcePlans(publication, {
    egressId: "test-egress",
    text: { ...compat, module: "codex.text" },
    ocr: { ...compat, module: "ocr.file" },
    visionConfigFingerprint: "b".repeat(64),
  });
  const input = {
    root,
    files,
    record,
    review,
    site,
    parsed,
    planning: { ...planning, parserVersion: "dtc-agent/1" as const },
    images: gallery.map((image) => ({
      ...files.find((file) => file.path === image.localPath),
      url: image.url,
      mediaType: image.mime,
    })),
    request: {
      runId: "11111111-1111-4111-8111-111111111111",
      channel: "dtc" as const,
      url,
      brandId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      operationId: "capture-test",
    },
  };
  const handoffs = new DtcVariantHandoffs({ publication, sourcePlans });
  return {
    root,
    input,
    publication,
    data,
    contexts,
    preflight,
    save,
    handoffs,
    sourcePlans,
    publish: () => handoffs.publish(input, new AbortController().signal),
  };
}
