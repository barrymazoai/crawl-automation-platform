import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFile, type CaptureFile } from "./archive.js";
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
