import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runHarvest } from "./run-harvest.mjs";
import { readObservedProduct, verifyObservedProduct } from "./observed-product.mjs";

// Mini-only historical fixtures, not production site rules. Never changes old originals/business state.
const fixtures = [
  { source: process.env.CRAWL_RETAINED_NATIVE_CAPTURE, name: "Solaray", htmlHash: "c4c97df8e10d8e361863a8b8fef0e8453ed738172d7b4fa51118dcf90651038f",
    fields: {
      description: { source: 0, selector: ".product__description" },
      ingredients: { source: 0, selector: "#ProductAccordion-671001b8-b593-4e08-8df7-0326f83241b9-template--23952998727740__main" },
      recommended_daily_intake: { source: 0, selector: "#ProductAccordion-3bd62d48-e97b-48c4-b7b2-6917cca57ac1-template--23952998727740__main" },
      notes: { source: 0, selector: "#ProductAccordion-collapsible_tab_fPapxK-template--23952998727740__main" },
      price: { source: 1, pointer: "/product/variants/0/price" },
      sku: { source: 1, pointer: "/product/variants/0/sku" },
    },
  },
  { source: process.env.CRAWL_RETAINED_HMW_CAPTURE, name: "HMW", htmlHash: "b6e9f7172d3845da58b5fdb4ab4f6761b8fcca0f151ba613cdea5ce281f7d2dc",
    fields: { description: { source: 0, selector: "details.hmw-pdpd-section:first-of-type .hmw-pdpd-body" } },
  },
];
for (const fixture of fixtures) {
  it.skipIf(!fixture.source)(`replays verified ${fixture.name} originals through an observed method without network`, async () => {
    const originals = [];
    for (const file of (await readdir(join(fixture.source, "native-originals"))).filter(name => name.endsWith(".receipt.json"))) {
      const receipt = JSON.parse(await readFile(join(fixture.source, "native-originals", file), "utf8"));
      if (!/^native-originals\/[a-f0-9]{64}\.(html|json|bin)$/.test(receipt.path)) throw new Error("invalid original path");
      const bytes = await readFile(join(fixture.source, receipt.path));
      expect(bytes.length).toBe(receipt.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256);
      originals.push({ ...receipt, bytes });
    }
    const attempt = JSON.parse(originals.find(item => item.kind === "harvest").bytes);
    expect(attempt.records).toHaveLength(1);
    const record = attempt.records[0];
    const html = originals.find(item => item.sha256 === fixture.htmlHash);
    const product = originals.find(item => item.kind === "json" && item.url === record.productUrl + ".json");
    const outDir = await realpath(await mkdtemp(join(tmpdir(), "native-retained-replay-")));
    vi.stubGlobal("fetch", () => { throw new Error("replay must not access network"); });
    vi.stubEnv("CRAWL_DTC_CAPTURE_MODE", "product");
    try {
      await writeFile(join(outDir, "source.html"), html.bytes, { flag: "wx" });
      await writeFile(join(outDir, "source.json"), product.bytes, { flag: "wx" });
      const method = { codec: "observed-product/1", productUrl: record.productUrl,
        sources: [{ path: "source.html", kind: "dom", url: html.url, sha256: html.sha256 },
          { path: "source.json", kind: "json", url: product.url, sha256: product.sha256 }],
        fields: { title: { source: 1, pointer: "/product/title" }, brand: { source: 1, pointer: "/product/vendor" }, ...fixture.fields },
        platform: { kind: "shopify", source: 1, pointer: "/product", offerSource: 0 },
      };
      const preview = await readObservedProduct(outDir, method);
      const browser = { mode: "ego-native", productUrl: record.productUrl, harvestHooks: {
        fetchProductData: async () => { throw new Error("native must not implicitly fetch platform data"); },
        fetchPageHtml: async () => html.bytes.toString(),
        fetchImage: async url => ({ bytes: originals.find(item => item.kind === "image" && item.url === url).bytes,
          mime: record.gallery.find(item => item.url === url).mime }),
      } };
      const result = await runHarvest(browser, null, attempt.plan, {
        outDir, observedGalleryUrls: record.gallery.map(item => item.url),
        hooks: { extract: async () => ({ records: [await readObservedProduct(outDir, method)], needsUpgrade: [], failed: [] }) },
      });
      expect(result.status).toBe("complete");
      const [saved] = JSON.parse(await readFile(join(outDir, "evidence/records.json"), "utf8"));
      await verifyObservedProduct(outDir, saved);
      expect(saved.fields).toMatchObject(preview.fields);
      expect(saved.variants).toEqual(record.variants);
      expect(saved.fields.supplement_facts).toBeUndefined();
      if (fixture.name === "Solaray") {
        expect(saved.fields.ingredients).toContain("Zinc (from Zinc Bisglycinate)");
        expect(saved.fields.recommended_daily_intake).toBe("Use only as directed. Take 1 VegCap daily with a meal or glass of water. Store in a cool, dry place.");
        expect(saved.fields.notes).not.toContain("Take 1 VegCap");
        expect(saved.fields.description).toContain("Delivers 50 mg of zinc");
      } else {
        expect(saved.fields.description).toContain("Your everyday baseline");
        expect(saved.fields.description).not.toContain("Your cart is empty");
        expect(saved.fields.price).toBeUndefined();
        expect(saved.fields.sku).toBeUndefined();
        expect(record.fields.description).toBe("Your cart is empty"); // old failure remains unchanged
      }
      expect(saved.gallery.map(item => item.url)).toEqual(record.gallery.map(item => item.url));
      for (const item of saved.gallery) {
        expect(await readFile(join(outDir, item.localPath))).toEqual(originals.find(original => original.url === item.url).bytes);
        expect(item.factsCandidateRank).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      await rm(outDir, { recursive: true, force: true });
    }
  });
}
