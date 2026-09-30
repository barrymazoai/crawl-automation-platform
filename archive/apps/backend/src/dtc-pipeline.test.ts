import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProcessingPrompt,
  countCapturedRecordsFromSemanticInput,
  findMissingProductUnifyFields,
  hydrateProductImagesFromEvidence,
  normalizeDtcBatchShapes,
} from "./dtc-pipeline.js";

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

describe("DTC Product Unify gate", () => {
  it("reports legacy records that omitted the new identity fields", () => {
    const problems = findMissingProductUnifyFields({
      schemaVersion: "2.0",
      products: [{ channel: "dtc", externalId: "example.com:shopify_variant:1" } as never],
      facts: [],
    });
    expect(problems[0]).toContain("titleRaw,variant,variantConfidence,variantSource,attrsRaw");
  });
});

describe("DTC sellable multipack policy", () => {
  it("keeps homogeneous beverage multipacks and excludes only mixed bundles", () => {
    const prompt = buildProcessingPrompt({
      sourceUrl: "https://example.com/",
      runId: "run-1",
      semanticInputFile: "/tmp/semantic-input.json",
      outputFile: "/tmp/product-batch.json",
      vocabulary: ["Healthy Aging"],
    });

    expect(prompt).toContain("同质多包装");
    expect(prompt).toContain("饮料按箱/多瓶销售尤其不能因 pack/bundle 字样排除");
    expect(prompt).toContain("混合组合装包含两个或以上不同产品、配方、口味或用途");
    expect(prompt).toContain("pack 数量写入 variant.pack");
    expect(prompt).toContain("禁止乘以 pack 数量");
    expect(prompt).toContain("净重/容量的单位舍入不是配方冲突");
    expect(prompt).toContain("1 oz = 28.3495 g");
    expect(prompt).toContain("返回 needs_review，不能以 complete 输出空数组");
    expect(prompt).toContain("family 只能是 null");
  });

  it("normalizes a legacy family label into the explicit family object", () => {
    const normalized = normalizeDtcBatchShapes({
      products: [
        { externalId: "1", family: "sparkling-collagen-water", capturedAt: "2026-08-29T13:39:18+08:00" },
        { externalId: "2", family: null },
      ],
      facts: [{ externalId: "1", capturedAt: "2026-08-29T13:39:18+08:00" }],
    }) as { products: Array<{ family: unknown; capturedAt?: string }>; facts: Array<{ capturedAt: string }> };

    expect(normalized.products[0]?.family).toEqual({
      parentExternalId: null,
      label: "sparkling-collagen-water",
      evidence: "explicit",
    });
    expect(normalized.products[1]?.family).toBeNull();
    expect(normalized.products[0]?.capturedAt).toBe("2026-08-29T05:39:18.000Z");
    expect(normalized.facts[0]?.capturedAt).toBe("2026-08-29T05:39:18.000Z");
  });

  it("counts captured records for the zero-output review gate", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtc-candidates-"));
    const recordsFile = path.join(directory, "records.json");
    const semanticInputFile = path.join(directory, "semantic-input.json");
    await fs.writeFile(recordsFile, JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
    await fs.writeFile(semanticInputFile, JSON.stringify({ sourceFiles: [{ path: recordsFile }] }));

    await expect(countCapturedRecordsFromSemanticInput(semanticInputFile)).resolves.toBe(3);
    await fs.rm(directory, { recursive: true, force: true });
  });
});
