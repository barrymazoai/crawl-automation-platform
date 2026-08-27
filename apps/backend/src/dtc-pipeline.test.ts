import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hydrateProductImagesFromEvidence } from "./dtc-pipeline.js";

describe("DTC processing evidence hydration", () => {
  it("fills omitted product images from the matching captured record", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtc-images-"));
    const recordsFile = path.join(directory, "records.json");
    const semanticInputFile = path.join(directory, "semantic-input.json");
    await fs.writeFile(recordsFile, JSON.stringify([{
      productUrl: "https://example.com/products/vitamin-c",
      fields: { images: ["https://cdn.example.com/vitamin-c.jpg"] },
    }]));
    await fs.writeFile(semanticInputFile, JSON.stringify({ sourceFiles: [{ path: recordsFile }] }));

    const hydrated = await hydrateProductImagesFromEvidence({
      schemaVersion: "2.0",
      products: [{ productUrl: "https://example.com/products/vitamin-c?variant=123" }],
      facts: [],
    }, semanticInputFile) as { products: Array<{ images: string[] }> };

    expect(hydrated.products[0]?.images).toEqual(["https://cdn.example.com/vitamin-c.jpg"]);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("preserves model images and defaults missing evidence to an empty array", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtc-images-"));
    const semanticInputFile = path.join(directory, "semantic-input.json");
    await fs.writeFile(semanticInputFile, JSON.stringify({ sourceFiles: [] }));

    const hydrated = await hydrateProductImagesFromEvidence({
      products: [
        { productUrl: "https://example.com/a", images: ["https://cdn.example.com/a.jpg"] },
        { productUrl: "https://example.com/b" },
      ],
    }, semanticInputFile) as { products: Array<{ images: string[] }> };

    expect(hydrated.products.map((product) => product.images)).toEqual([
      ["https://cdn.example.com/a.jpg"],
      [],
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  });
});
