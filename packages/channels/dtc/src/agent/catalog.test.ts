import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DtcAgentBrandScan } from "./catalog.js";
import { dtcSitePolicy } from "../site-policy.js";

it.each(["single-brand", "multi-brand", "foreign-domain"] as const)(
  "verifies multiple category seeds within %s scope",
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-catalog-scope-")));
    try {
      const sourceUrl = "https://shop.example/collections/alpha";
      const site = dtcSitePolicy({
        siteKey: "shop.example",
        platform: "shopify",
        ...(kind === "multi-brand"
          ? { kind, brands: [{ brand: "Alpha", catalogUrl: sourceUrl }] }
          : { catalogUrl: sourceUrl }),
      });
      const urls = [
        sourceUrl,
        kind === "foreign-domain"
          ? "https://other.example/collections/all"
          : "https://shop.example/collections/minerals",
      ];
      const pages = urls.map((url) => ({
        url,
        htmlPath: "page.html",
        screenshotPath: "page.png",
        entries: [{ url: "https://shop.example/products/zinc", title: "Zinc", brand: "Alpha" }],
      }));
      await writeFile(join(root, "page.html"), '<main><a href="/products/zinc">Zinc</a></main>');
      await writeFile(
        join(root, "catalog-discovery.json"),
        JSON.stringify({
          codec: "catalog-discovery/1",
          complete: true,
          zeroGrowthRounds: 1,
          productUrls: ["https://shop.example/products/zinc"],
          pages: [1, 2].map((round) => ({
            round,
            htmlPath: "page.html",
            screenshotPath: "page.png",
          })),
          rounds: [1, 2].map((round) => ({
            round,
            growth: round === 1 ? 1 : 0,
            coverageComplete: true,
            productUrls: ["https://shop.example/products/zinc"],
          })),
        }),
      );
      await writeFile(
        join(root, "catalog.json"),
        JSON.stringify({
          pages,
          complete: true,
          termination: {
            exhausted: true,
            reason: "all seeds ended",
            method: "visual traversal",
            evidence: ["page.png"],
            zeroGrowthRounds: 1,
            oracle: { expected: 1, observed: 1, comparable: true },
          },
        }),
      );
      const scanner = new DtcAgentBrandScan({
        sites: [site],
        agent: {
          capture: async () => ({
            root,
            prefix: "test",
            manifestKey: "test/capture.json",
            evidenceFiles: [],
            files: [
              ...["catalog-discovery.json", "page.html"].map((path) => ({
                path,
                objectKey: path,
                mediaType: "application/json",
                byteSize: 1,
                sha256: "a".repeat(64),
              })),
              {
                path: "page.png",
                objectKey: "image",
                mediaType: "image/png",
                byteSize: 1,
                sha256: "a".repeat(64),
              },
            ],
          }),
        },
      });
      const result = scanner.scan({ scanId: "scan", sourceUrl }, new AbortController().signal);
      if (kind === "single-brand") {
        await expect(result).resolves.toMatchObject({
          complete: true,
          pages: [{ cards: 1 }, { cards: 0 }],
        });
      } else {
        await expect(result).rejects.toMatchObject({ code: "CHANNEL.URL_REJECTED" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
