import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureFile, captureOutputFiles, type CaptureFile } from "./archive.js";
import { readCapturedProduct } from "./product-record.js";
import { capturedProductProjection } from "./product-projection.js";
import { dtcSitePolicy } from "../site-policy.js";

let root: string;
const url = "https://shop.example/products/zinc";
const image = "https://shop.example/gallery/front.png";
const record = {
  productUrl: url,
  fields: { title: "Zinc", description: "Original product description" },
  variants: [],
  pageHtml: "product.html",
  flags: [],
  gallery: [{ url: image, localPath: "front.png", mime: "image/png" }],
};
const review = {
  productUrl: url,
  selectedVariantId: null,
  galleryUrls: [image],
  galleryComplete: true,
  variantsComplete: true,
  detailComplete: true,
  method: "viewed every carousel item and retained image",
  surface: "local_file",
  verifier: "codex",
  evidence: ["front.png"],
  imageAssignments: [{ url: image, variantId: null, basis: "product-gallery" }],
};
const files: CaptureFile[] = ["front.png", "product.html"].map((path) => ({
  path,
  objectKey: `test/${path}`,
  byteSize: 10,
  sha256: "a".repeat(64),
  mediaType: path.endsWith("png") ? "image/png" : "text/html",
}));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dtc-native-record-")));
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, "evidence/records.json"), JSON.stringify([record]));
  await writeFile(join(root, "capture-review.json"), JSON.stringify(review));
  await writeFile(join(root, "product.html"), "<main>Zinc <img src='/badge.svg'></main>");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("uses the harvested gallery, excluding unrelated HTML badges", async () => {
  const result = await readCapturedProduct({ root, files, url });
  const parsed = capturedProductProjection({
    ...result,
    url,
    site: dtcSitePolicy({
      siteKey: "shop.example",
      platform: "shopify",
      catalogUrl: "https://shop.example/collections/all",
    }),
  });
  expect(parsed.evidence.imageCandidates.map((candidate) => candidate.url)).toEqual([image]);
  expect(parsed.evidence.detailsHtml).toContain("Original product description");
});

it.each(["missing", "wrong-product", "partial", "wrong-variant"])(
  "rejects %s evidence before downstream planning",
  async (failure) => {
    const changed = structuredClone(review);
    if (failure === "wrong-product") {
      changed.productUrl = "https://shop.example/products/other";
    }
    if (failure === "partial") {
      changed.galleryComplete = false;
    }
    await writeFile(join(root, "capture-review.json"), JSON.stringify(changed));
    await expect(
      readCapturedProduct({
        root,
        files: failure === "missing" ? [] : files,
        url: failure === "wrong-variant" ? `${url}?variant=other` : url,
      }),
    ).rejects.toThrow();
  },
);

it("rejects path traversal and symlink evidence", async () => {
  await symlink(join(root, "product.html"), join(root, "linked.html"));
  await expect(captureFile(root, "linked.html")).rejects.toMatchObject({
    code: "DTC.CAPTURE_PATH",
  });
  await expect(captureFile(root, "../outside.html")).rejects.toMatchObject({
    code: "DTC.CAPTURE_PATH",
  });
});

it("accepts an archived workspace screenshot without admitting it as a product asset", async () => {
  const retained = captureOutputFiles([
    ...files.map((file) => ({ ...file, path: `capture/${file.path}` })),
    { ...(files[0] as CaptureFile), path: "preflight.png" },
  ]);
  await writeFile(
    join(root, "capture-review.json"),
    JSON.stringify({ ...review, evidence: ["../preflight.png"] }),
  );
  await expect(readCapturedProduct({ root, ...retained, url })).resolves.toBeDefined();
  await expect(readCapturedProduct({ root, files: retained.files, url })).rejects.toThrow();
  await writeFile(
    join(root, "evidence/records.json"),
    JSON.stringify([
      { ...record, gallery: [{ ...record.gallery[0], localPath: "../preflight.png" }] },
    ]),
  );
  await expect(readCapturedProduct({ root, ...retained, url })).rejects.toThrow();
});

it("rejects unarchived review references outside the task", async () => {
  await writeFile(
    join(root, "capture-review.json"),
    JSON.stringify({ ...review, evidence: ["../../other-task/preflight.png"] }),
  );
  await expect(readCapturedProduct({ root, files, evidenceFiles: files, url })).rejects.toThrow();
});

it.each([1, 2])(
  "preserves website variants and their full gallery independently (%i variants)",
  async (count) => {
    const facts = "https://shop.example/gallery/facts.png";
    const variants = ["one", "two"].slice(0, count).map((variantId) => ({
      variantId,
      sku: `website-sku-${variantId}`,
      options: { Size: variantId === "one" ? "30 capsules" : "60 capsules" },
      price: variantId === "one" ? "9.99" : "34.99",
      available: variantId !== "one",
      availability: variantId === "one" ? "OutOfStock" : "InStock",
      imageUrl: image,
      url: `${url}?variant=${variantId}`,
    }));
    await writeFile(
      join(root, "evidence/records.json"),
      JSON.stringify([
        {
          ...record,
          variants,
          gallery: [...record.gallery, { url: facts, localPath: "facts.png", mime: "image/png" }],
        },
      ]),
    );
    await writeFile(
      join(root, "capture-review.json"),
      JSON.stringify({
        ...review,
        selectedVariantId: "one",
        galleryUrls: [image, facts],
        imageAssignments: [
          { url: image, variantId: "one", basis: "variant-featured" },
          { url: facts, variantId: null, basis: "product-gallery" },
        ],
      }),
    );
    const result = await readCapturedProduct({
      root,
      url,
      files: [...files, { ...(files[0] as CaptureFile), path: "facts.png" }],
    });
    const project = () =>
      capturedProductProjection({
        ...result,
        url,
        site: dtcSitePolicy({
          siteKey: "shop.example",
          platform: "shopify",
          catalogUrl: "https://shop.example/collections/all",
        }),
      });
    expect(result.record.variants).toEqual(variants);
    expect(project().evidence.variantOptions).toEqual(count === 1 ? ["Size: 30 capsules"] : []);
    expect(project().evidence.variants.map((variant) => variant.variantId)).toEqual(
      variants.map((variant) => variant.variantId),
    );
    expect(project().evidence.variants).toMatchObject(variants);
    expect(
      project().evidence.imageCandidates.map((candidate) => [candidate.url, candidate.variantId]),
    ).toEqual([
      [image, "one"],
      [facts, count === 1 ? "one" : null],
    ]);
    if (count === 2) {
      const other = "https://shop.example/gallery/other-size.png";
      result.review.imageAssignments.push({
        url: other,
        variantId: "two",
        basis: "variant-featured",
      });
      expect(project().evidence.imageCandidates.at(-1)).toMatchObject({
        url: other,
        variantId: "two",
        basis: "variant-featured",
      });
      expect(result.review.imageAssignments.at(-1)?.variantId).toBe("two");
      const explicit = capturedProductProjection({
        ...result,
        url: `${url}?variant=one`,
        site: dtcSitePolicy({
          siteKey: "shop.example",
          platform: "shopify",
          catalogUrl: "https://shop.example/collections/all",
        }),
      });
      expect(project().identity.variantId).toBeNull();
      expect(explicit.identity.variantId).toBe("one");
      expect(explicit.evidence.variantOptions).toEqual(["Size: 30 capsules"]);
      expect(explicit.evidence.imageCandidates.at(-1)?.variantId).toBe("two");
    }
  },
);

it.each(["valid", "missing-method", "changed-field", "unarchived", "changed-original"])(
  "verifies the observed field method against archived originals: %s",
  async (scenario) => {
    const html =
      "<main><h1>Zinc</h1><p class='brand'>Actual Brand</p><p class='description'>Original product description</p></main>";
    await writeFile(join(root, "product.html"), html);
    const sha256 = createHash("sha256").update(html).digest("hex");
    const fieldEvidence = {
      codec: "observed-product/1",
      productUrl: url,
      sources: [{ path: "product.html", kind: "dom", url, sha256 }],
      fields: {
        title: { source: 0, selector: "main h1" },
        brand: { source: 0, selector: "main .brand" },
        description: { source: 0, selector: "main .description" },
      },
    };
    await writeFile(
      join(root, "evidence/records.json"),
      JSON.stringify([
        {
          ...record,
          fields: {
            ...record.fields,
            brand: "Actual Brand",
            ...(scenario === "changed-field" ? { price: "$49.98" } : {}),
          },
          ...(scenario === "missing-method" ? {} : { fieldEvidence }),
        },
      ]),
    );
    if (scenario === "changed-original") {
      await writeFile(join(root, "product.html"), "different page");
    }
    const promise = readCapturedProduct({
      root,
      url,
      requireObservedMethod: true,
      files: files.map((file) =>
        file.path === "product.html" && scenario !== "unarchived"
          ? { ...file, sha256, byteSize: Buffer.byteLength(html) }
          : file,
      ),
    });
    if (scenario === "valid") {
      await expect(promise).resolves.toMatchObject({
        record: { fields: { brand: "Actual Brand" } },
      });
    } else {
      await expect(promise).rejects.toMatchObject({ code: "DTC.CAPTURE_EVIDENCE" });
    }
  },
);
