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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DtcAgentFileTransport } from "./file-transport.js";

let test: Awaited<ReturnType<typeof variantCaptureFixture>>;
beforeEach(async () => {
  test = await variantCaptureFixture();
});
afterEach(async () => {
  await rm(test.root, { recursive: true, force: true });
});

it("isolates mixed flavour text/images and preserves every website variant including sold-out", async () => {
  const members = await test.publish();
  expect(
    members.map((member) => [member.status, member.variant.variantId, member.variant.available]),
  ).toEqual([
    ["ready", "1", false],
    ["ready", "2", true],
  ]);
  expect(new Set(members.map((member) => member.operationId)).size).toBe(2);
  for (const member of members) {
    if (member.status !== "ready") {
      throw new Error(member.reason);
    }
    const plan = member.planned.sourcePlan;
    const saved = JSON.parse(Buffer.from(test.data.get(plan.source.objectKey) ?? []).toString());
    const projection = saved.evidence;
    expect(test.input.planning.read(saved, member.variant.url, plan.owner).evidence.brandRaw).toBe(
      "Actual Brand",
    );
    expect(projection.variantId).toBe(member.variant.variantId);
    expect(projection.variants).toEqual(test.input.parsed.evidence.variants);
    expect(projection.detailsHtml).toContain(
      member.variant.variantId === "1" ? "Orange peel" : "Berry extract",
    );
    expect(projection.detailsHtml).not.toContain(
      member.variant.variantId === "1" ? "Berry extract" : "Orange peel",
    );
    expect(projection.imageCandidates).toHaveLength(1);
    expect(projection.imageCandidates[0].variantId).toBe(member.variant.variantId);
    expect(member.planned.family).toMatchObject({ differsBy: "flavour" });
    const transport = new DtcAgentFileTransport(test.publication, {
      operationId: member.operationId,
      url: member.variant.url,
      egressId: "test-egress",
    });
    const response = await transport.get(
      new URL(projection.imageCandidates[0].url),
      undefined,
      {},
      new AbortController().signal,
    );
    const bytes = [];
    for await (const chunk of response.body) {
      bytes.push(chunk);
    }
    expect(Buffer.concat(bytes).toString()).toBe(`retained-image-${member.variant.variantId}`);
    const other = test.input.images.find(
      (image) => image.url !== projection.imageCandidates[0].url,
    );
    await expect(
      transport.get(new URL(other?.url ?? ""), undefined, {}, new AbortController().signal),
    ).rejects.toThrow();
  }
  expect(test.input.record.fields).not.toHaveProperty("sku");
  expect(test.input.record.gallery).toHaveLength(2);
});

it("reads legacy single-brand projections while rejecting a mismatched native brand proof", async () => {
  const legacy = { ...test.input.parsed.evidence, brandRaw: test.input.site.siteKey };
  expect(
    test.input.planning.read(legacy, test.input.request.url, test.input.parsed.identity).evidence
      .brandRaw,
  ).toBe(test.input.site.siteKey);
  const [member] = await test.publish();
  if (!member || member.status !== "ready") {
    throw new Error("fixture");
  }
  const plan = member.planned.sourcePlan;
  const saved = JSON.parse(Buffer.from(test.data.get(plan.source.objectKey) ?? []).toString());
  saved.evidence.brandRaw = "Other Brand";
  expect(() => test.input.planning.read(saved, member.variant.url, plan.owner)).toThrow();
});

it.each([
  "missing",
  "duplicate",
  "wrong-state",
  "unarchived-method",
  "changed-original",
  "wrong-gallery",
  "unresolved",
])("keeps the healthy sibling when one variant has %s evidence", async (failure) => {
  const contexts = test.input.review.variantContexts ?? [];
  const context = contexts[0] as Record<string, unknown>;
  if (failure === "missing") {
    contexts.shift();
  }
  if (failure === "duplicate") {
    contexts.push(context);
  }
  if (failure === "wrong-state") {
    context.methodPath = "method-2.json";
  }
  if (failure === "unarchived-method") {
    context.methodPath = "absent.json";
  }
  if (failure === "changed-original") {
    await writeFile(join(test.root, "variant-1.html"), "changed");
  }
  if (failure === "wrong-gallery") {
    context.galleryUrls = [test.input.record.gallery[1]?.url];
  }
  if (failure === "unresolved") {
    contexts[0] = {
      variantId: "1",
      status: "unresolved",
      reason: "Cannot access sold-out option",
      evidence: ["variant-1.html"],
    };
  }
  expect((await test.publish()).map((member) => member.status)).toEqual(["review", "ready"]);
});

it("reports both old unscoped variants as Review without inventing a default formula", async () => {
  delete test.input.review.variantContexts;
  const members = await test.publish();
  expect(members.map((member) => member.status)).toEqual(["review", "review"]);
  expect([...test.data.keys()].some((key) => key.includes("projection.json"))).toBe(false);
});

it("uses an explicit website-shared scope only when retained and does not infer it from null image bindings", async () => {
  const contexts = test.input.review.variantContexts as Record<string, unknown>[];
  for (const context of contexts) {
    context.methodPath = "base-method.json";
    context.basis = "website-shared";
    context.reason = "Website says these details apply to both package sizes";
    context.difference = { kind: "size", group: "Size" };
  }
  test.input.review.imageAssignments.forEach((image) => {
    image.variantId = null;
  });
  const members = await test.publish();
  expect(members.map((member) => member.status)).toEqual(["ready", "ready"]);
  expect(members[1]).toMatchObject({ planned: { family: { differsBy: "size" } } });
});

it("does not relabel an R2 publication failure as variant ambiguity", async () => {
  vi.spyOn(test.publication, "publish").mockRejectedValue(new Error("R2 unavailable"));
  await expect(test.publish()).rejects.toThrow("R2 unavailable");
});

it("limits an explicit-variant task to the requested website identity", async () => {
  test.input.parsed.identity.variantId = "2";
  const members = await test.publish();
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({
    status: "ready",
    variant: { variantId: "2", sku: "BERRY", price: "34.99" },
  });
});

/** Synthetic website originals for offline isolation tests; no browser/network/model. */
async function variantCaptureFixture() {
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
  const contexts = [];
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
    save,
    handoffs,
    publish: () => handoffs.publish(input, new AbortController().signal),
  };
}
