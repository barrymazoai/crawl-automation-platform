import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAmazonImageEvidence } from "./backfill-image.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Amazon backfill image evidence lane", () => {
  it("OCRs images concurrently, keeps only Facts candidates, and caches OCR", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amazon-image-lane-"));
    directories.push(directory);
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    const recognize = vi.fn(async (filename: string) => ({
      text: filename.includes("never") ? "Marketing" : "Supplement Facts Serving Size 1 Capsule",
      lines: [],
    }));
    const images = [
      { id: "image-1", productId: "product-1", imageUrl: "https://img.example/one.jpg" },
      { id: "image-2", productId: "product-1", imageUrl: "https://img.example/two.jpg" },
    ];
    const first = await buildAmazonImageEvidence({ productId: "product-1", images, cacheDirectory: directory, imageConcurrency: 2, recognize, fetchImpl });
    expect(first).toMatchObject({ totalImages: 2, ocrSucceeded: 2, ocrFailed: 0 });
    expect(first.factsCandidates).toHaveLength(2);
    expect(recognize).toHaveBeenCalledTimes(2);
    await buildAmazonImageEvidence({ productId: "product-1", images, cacheDirectory: directory, imageConcurrency: 2, recognize, fetchImpl });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("records a failed image without discarding successful evidence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amazon-image-lane-"));
    directories.push(directory);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes("bad")
      ? new Response("", { status: 404 })
      : new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const result = await buildAmazonImageEvidence({
      productId: "product-1",
      images: [
        { id: "good", productId: "product-1", imageUrl: "https://img.example/good.png" },
        { id: "bad", productId: "product-1", imageUrl: "https://img.example/bad.png" },
      ],
      cacheDirectory: directory,
      imageConcurrency: 2,
      fetchImpl,
      recognize: async () => ({ text: "Supplement Facts Serving Size 1 Capsule", lines: [] }),
    });
    expect(result).toMatchObject({ ocrSucceeded: 1, ocrFailed: 1 });
    expect(result.factsCandidates).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe("image_http_404");
  });

  it("resolves an object key before download while caching by the stable key", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amazon-image-lane-"));
    directories.push(directory);
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    const resolveImageUrl = vi.fn(async () => "https://signed.example/image.jpg?signature=one");
    const input = {
      productId: "product-1",
      images: [{ id: "image-1", productId: "product-1", imageUrl: "product-images/amazon/image.jpg" }],
      cacheDirectory: directory,
      imageConcurrency: 1,
      fetchImpl,
      resolveImageUrl,
      recognize: async () => ({ text: "Supplement Facts Serving Size 1 Capsule", lines: [] }),
    };
    await buildAmazonImageEvidence(input);
    await buildAmazonImageEvidence({ ...input, resolveImageUrl: async () => "https://signed.example/image.jpg?signature=two" });
    expect(resolveImageUrl).toHaveBeenCalledWith("product-images/amazon/image.jpg");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
