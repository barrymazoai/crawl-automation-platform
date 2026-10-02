import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runHarvest } from "./run-harvest.mjs";

// Mini-only replay of an existing capture. Originals and business state are never modified.
const source = process.env.CRAWL_RETAINED_NATIVE_CAPTURE;
it.skipIf(!source)("replays verified native originals into a separate directory without a browser or network", async () => {
  const originals = [];
  for (const file of (await readdir(join(source, "native-originals"))).filter(name => name.endsWith(".receipt.json"))) {
    const receipt = JSON.parse(await readFile(join(source, "native-originals", file), "utf8"));
    if (!/^native-originals\/[a-f0-9]{64}\.(html|json|bin)$/.test(receipt.path)) throw new Error("invalid original path");
    const bytes = await readFile(join(source, receipt.path));
    expect(bytes.length).toBe(receipt.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256);
    originals.push({ ...receipt, bytes });
  }
  const attempt = JSON.parse(originals.find(item => item.kind === "harvest").bytes);
  expect(attempt.records).toHaveLength(1);
  const record = attempt.records[0];
  const product = JSON.parse(originals.find(item => item.kind === "json").bytes).product;
  const outDir = await mkdtemp(join(tmpdir(), "native-retained-replay-"));
  vi.stubGlobal("fetch", () => { throw new Error("replay must not access network"); });
  try {
    const browser = { mode: "ego-native", productUrl: record.productUrl, harvestHooks: {
      fetchProductData: async () => product,
      fetchPageHtml: async url => originals.find(item => item.kind === "html" && item.url === url).bytes.toString(),
      fetchImage: async url => ({ bytes: originals.find(item => item.kind === "image" && item.url === url).bytes,
        mime: record.gallery.find(item => item.url === url).mime }),
    } };
    const result = await runHarvest(browser, null, attempt.plan, {
      outDir, observedGalleryUrls: record.gallery.map(item => item.url),
      hooks: {
        extract: async () => ({ records: [{ sourceUrl: record.productUrl, fields: record.fields, variants: record.variants }], needsUpgrade: [], failed: [] }),
        filterScope: records => ({ included: records, excluded: [] }),
      },
    });
    expect(result.status).toBe("complete");
    const [saved] = JSON.parse(await readFile(join(outDir, "evidence/records.json"), "utf8"));
    expect(saved.fields.brand).toBe(record.fields.brand || product.vendor);
    expect(saved.variants).toEqual(record.variants);
    expect(saved.gallery.map(item => item.url)).toEqual(record.gallery.map(item => item.url));
    for (const item of saved.gallery) {
      expect(await readFile(join(outDir, item.localPath))).toEqual(originals.find(original => original.url === item.url).bytes);
    }
  } finally {
    vi.unstubAllGlobals();
    await rm(outDir, { recursive: true, force: true });
  }
});
