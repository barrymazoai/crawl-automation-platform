import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dtcSitePolicy } from "../site-policy.js";
import { dtcProductAddress } from "../address.js";
import { verifyCatalogDiscovery } from "./catalog-discovery.js";

it.each([
  "valid",
  "one-round",
  "false-growth",
  "false-stable",
  "missing-round-page",
  "wrong-products",
])("checks retained discovery rounds: %s", async (scenario) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-round-proof-")));
  const url = "https://shop.example/products/zinc";
  const site = dtcSitePolicy({
    siteKey: "shop.example",
    platform: "shopify",
    catalogUrl: "https://shop.example/collections/all",
  });
  const proof = {
    codec: "catalog-discovery/1",
    complete: true,
    zeroGrowthRounds: 1,
    productUrls: [url],
    rounds: [1, 2].map((round) => ({
      round,
      growth: round === 1 ? 1 : 0,
      productUrls: [url],
      coverageComplete: true,
    })),
    pages: [1, 2].map((round) => ({
      round,
      htmlPath: `${round}.html`,
      screenshotPath: `${round}.png`,
    })),
  };
  if (scenario === "one-round") {
    proof.rounds.pop();
  }
  if (scenario === "false-growth") {
    proof.rounds = proof.rounds.map((round) => ({ ...round, growth: 0 }));
  }
  if (scenario === "false-stable") {
    proof.zeroGrowthRounds = 2;
  }
  if (scenario === "missing-round-page") {
    proof.pages.pop();
  }
  if (scenario === "wrong-products") {
    proof.productUrls = ["https://shop.example/products/other"];
  }
  try {
    await writeFile(join(root, "catalog-discovery.json"), JSON.stringify(proof));
    const files = ["catalog-discovery.json", "1.html", "1.png", "2.html", "2.png"].map((path) => ({
      path,
      objectKey: path,
      mediaType: "application/json",
      sha256: "a".repeat(64),
      byteSize: 1,
    }));
    const checked = verifyCatalogDiscovery(
      { root, files },
      {
        complete: true,
        zeroGrowthRounds: 1,
        listingIds: new Set([dtcProductAddress(url, [site]).listingId]),
        site,
      },
    );
    if (scenario === "valid") {
      await expect(checked).resolves.toBeUndefined();
    } else {
      await expect(checked).rejects.toMatchObject({ code: "DTC.CAPTURE_EVIDENCE" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
