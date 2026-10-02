import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DtcAgentBrandScan } from "./catalog.js";
import { dtcSitePolicy } from "../site-policy.js";

it.each([
  "valid",
  "missing-response",
  "changed-response",
  "changed-dom",
  "wrong-method",
  "wrong-seed",
  "api-only",
])("verifies native Shopify catalog originals at the host boundary: %s", async (scenario) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-shopify-catalog-")));
  const sourceUrl = "https://shop.example/collections/minerals";
  const url = "https://shop.example/products/zinc";
  const html = '<main><a href="/products/zinc">Zinc</a></main>';
  const entries = [{ url, title: "Zinc", brand: "Alpha" }];
  const responses = [[{ id: 1, handle: "zinc" }], []].map((products, index) => ({
    url: `https://shop.example/collections/minerals/products.json?limit=100&page=${index + 1}`,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ products }),
  }));
  const firstResponse = responses[0];
  if (scenario === "api-only" && firstResponse) {
    firstResponse.body = JSON.stringify({
      products: [
        { id: 1, handle: "zinc" },
        { id: 2, handle: "other" },
      ],
    });
  }
  const coverage = {
    version: "shopify-collection-products/1",
    catalogUrl: sourceUrl,
    dom: { url: sourceUrl, links: [url] },
    responses,
  };
  const page = { url: sourceUrl, htmlPath: "page.html", screenshotPath: "page.png", entries };
  const discovery = {
    codec: "catalog-discovery/1",
    complete: true,
    completionProof: "shopify",
    requiredZeroGrowthRounds: 1,
    zeroGrowthRounds: 0,
    productUrls: [url],
    seedUrls: [scenario === "wrong-seed" ? "https://shop.example/collections/all" : sourceUrl],
    pages: [{ ...page, round: 1 }],
    rounds: [{ round: 1, growth: 1, coverageComplete: true, productUrls: [url] }],
  };
  const catalog = {
    complete: true,
    pages: [page],
    termination: {
      proof: scenario === "wrong-method" ? "enumeration" : "shopify",
      exhausted: true,
      reason: "matching directory and bounded platform set",
      method: "legacy Shopify oracle",
      evidence: ["catalog-coverage.json"],
      zeroGrowthRounds: 0,
      oracle: { expected: 1, observed: 1, comparable: true },
    },
  };
  const contents: Record<string, string> = {
    "catalog.json": JSON.stringify(catalog),
    "catalog-discovery.json": JSON.stringify(discovery),
    "catalog-coverage.json": JSON.stringify(coverage),
    "catalog-coverage-evidence.json": JSON.stringify({
      catalogRoot: "main",
      htmlPath: "oracle.html",
      screenshotPath: "page.png",
    }),
    "page.html": html,
    "oracle.html": scenario === "changed-dom" ? "<main></main>" : html,
    "page.png": "image",
    "catalog-shopify-response-1.json": JSON.stringify(responses[0]),
    "catalog-shopify-response-2.json": JSON.stringify(responses[1]),
  };
  if (scenario === "missing-response") {
    delete contents["catalog-shopify-response-2.json"];
  }
  if (scenario === "changed-response") {
    contents["catalog-shopify-response-1.json"] = JSON.stringify({
      ...responses[0],
      body: '{"products":[]}',
    });
  }
  try {
    for (const [path, content] of Object.entries(contents)) {
      await writeFile(join(root, path), content);
    }
    const scanner = new DtcAgentBrandScan({
      sites: [
        dtcSitePolicy({ siteKey: "shop.example", platform: "shopify", catalogUrl: sourceUrl }),
      ],
      agent: {
        capture: async () => ({
          root,
          prefix: "test",
          manifestKey: "test/archive.json",
          evidenceFiles: [],
          files: Object.entries(contents).map(([path, content]) => ({
            path,
            objectKey: path,
            mediaType: path.endsWith(".png") ? "image/png" : "application/json",
            byteSize: Buffer.byteLength(content),
            sha256: createHash("sha256").update(content).digest("hex"),
          })),
        }),
      },
    });
    const result = scanner.scan({ scanId: "scan", sourceUrl }, new AbortController().signal);
    if (scenario === "valid") {
      await expect(result).resolves.toMatchObject({ complete: true, pages: [{ cards: 1 }] });
    } else {
      await expect(result).rejects.toMatchObject({ code: "DTC.CAPTURE_EVIDENCE" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
