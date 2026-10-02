import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCatalog } from "./catalog-discovery.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(rounds) {
  const outDir = await mkdtemp(join(tmpdir(), "catalog-discovery-")); roots.push(outDir);
  const tab = { playwright: { evaluate: async () => '<main><a href="/products/zinc">Zinc</a></main>' },
    screenshot: async ({path}) => writeFile(path, "image") };
  const enumerate = vi.fn(async (_tab, seeds, opts) => {
    const urls = rounds.shift();
    if (urls instanceof Error) throw urls;
    await opts.onListingPage({url: seeds[0], productUrls: urls ?? []});
    return { productUrls: urls ?? [], coverage: { status: urls ? "complete" : "incomplete", seedReports: [] } };
  });
  return { tab, outDir, enumerate };
}
it("rechecks a single-page catalog, retaining each observed page before declaring exhaustion", async () => {
  const url = "https://shop.example/products/zinc";
  const f = await fixture([[url], [url]]);
  const result = await discoverCatalog(f.tab, ["https://shop.example/collections/all"], f);
  expect(result).toMatchObject({ complete: true, zeroGrowthRounds: 1, productUrls: [url] });
  expect(result.rounds.map(r => r.growth)).toEqual([1, 0]);
  expect(result.pages).toHaveLength(2);
  expect(f.enumerate.mock.calls[1][2].known).toEqual([url]);
  expect(JSON.parse(await readFile(join(f.outDir, "catalog-discovery.json"), "utf8"))).toEqual(result);
  expect(await readFile(join(f.outDir, result.pages[0].htmlPath), "utf8")).toContain("Zinc");
});
it("continues when a late product appears, until a subsequent whole round adds nothing", async () => {
  const f = await fixture([["one"], ["one", "two"], ["one", "two"]]);
  expect((await discoverCatalog(f.tab, ["seed"], f)).rounds.map(r => r.growth)).toEqual([1, 1, 0]);
});
it("does not silently retry incomplete discovery", async () => {
  const f = await fixture([null]);
  expect(await discoverCatalog(f.tab, ["seed"], f)).toMatchObject({ complete: false, reason: "coverage_incomplete" });
  expect(f.enumerate).toHaveBeenCalledTimes(1);
});
it("retains a failure without running another round", async () => {
  const f = await fixture([["one"], new Error("browser disconnected")]);
  await expect(discoverCatalog(f.tab, ["seed"], f)).rejects.toThrow("browser disconnected");
  expect(JSON.parse(await readFile(join(f.outDir, "catalog-discovery.json"), "utf8"))).toMatchObject({ complete: false, productUrls: ["one"] });
  expect(f.enumerate).toHaveBeenCalledTimes(2);
});
it("keeps a round budget incomplete when the catalog continues growing", async () => {
  const f = await fixture([["one"], ["one", "two"]]);
  expect(await discoverCatalog(f.tab, ["seed"], { ...f, maxRounds: 2 })).toMatchObject({ complete: false, reason: "round_limit" });
});
