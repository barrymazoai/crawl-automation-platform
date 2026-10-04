import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { createEgoBrowser } from "./ego-native-browser.mjs";
import { discoverCatalog } from "./catalog-discovery.mjs";

/** The site module supplies observed methods; this launcher owns traversal and output. */
export async function runCatalogCapture(input, globals) {
  const { cwd, outDir, profileDir, sourceUrl, methodPath, taskSpaceId, label, targetId } = input;
  const task = await globals.taskSpace(taskSpaceId);
  const page = await task.page(label);
  const browser = createEgoBrowser({ task, page, targetId, listTaskSpaces: globals.listTaskSpaces,
    workDir: cwd, captureMode: "catalog" });
  const bytes = await readFile(methodPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const method = await import(pathToFileURL(methodPath).href);
  if (typeof method.prepare !== "function" || typeof method.projectPage !== "function") {
    throw new Error("catalog_method_exports_required");
  }
  await writeFile(join(outDir, "catalog-method.mjs"), bytes, { flag: "wx" });
  await writeFile(join(outDir, "catalog-script-use.json"), JSON.stringify({
    codec: "dtc-catalog-script-use/1", sourceUrl, sha256,
  }), { flag: "wx" });
  const prepared = await method.prepare({ page, tab: browser.tab, sourceUrl, outDir });
  const { seedUrls, listingOptions, oracle } = prepared;
  if (!Array.isArray(seedUrls) || !seedUrls.length || !listingOptions
    || ["enumerate", "onListingPage", "outDir", "profileDir"].some(key => key in listingOptions)
    || typeof oracle?.comparable !== "boolean"
    || (oracle.comparable && (!Number.isInteger(oracle.expected) || oracle.expected < 0))) {
    throw new Error("catalog_preparation_invalid");
  }
  await writeFile(join(outDir, "catalog-preparation.json"), JSON.stringify(prepared, null, 2), { flag: "wx" });
  const html = await browser.tab.playwright.evaluate(() => document.documentElement.outerHTML);
  await writeFile(join(outDir, "catalog-preparation.html"), html, { flag: "wx" });
  await browser.tab.screenshot({ path: join(outDir, "catalog-preparation.png") });
  const discovery = await discoverCatalog(browser.tab, seedUrls, { ...listingOptions, outDir, profileDir });
  const catalog = await projectCatalog({ method, discovery, outDir, sourceUrl, oracle });
  if (!bytes.equals(await readFile(methodPath))) throw new Error("catalog_method_changed_during_capture");
  await writeFile(join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2), { flag: "wx" });
  return { complete: catalog.complete, products: discovery.productUrls.length,
    pages: catalog.pages.length, reason: catalog.termination.reason };
}

async function projectCatalog({ method, discovery, outDir, sourceUrl, oracle }) {
  const pages = [];
  for (const saved of discovery.pages) {
    const { document } = parseHTML(await readFile(join(outDir, saved.htmlPath), "utf8"));
    const entries = await method.projectPage({ document, url: saved.url, sourceUrl });
    const expected = new Set(saved.productUrls);
    if (!Array.isArray(entries) || entries.length !== expected.size
      || new Set(entries.map(entry => entry.url)).size !== expected.size
      || entries.some(entry => !expected.has(entry.url) || !entry.title?.trim()
        || (entry.brand !== null && typeof entry.brand !== "string"))) {
      throw new Error("catalog_page_projection_mismatch");
    }
    pages.push({ url: saved.url, htmlPath: saved.htmlPath, screenshotPath: saved.screenshotPath, entries });
  }
  const observed = discovery.productUrls.length;
  const consistent = !oracle.comparable || oracle.expected === observed;
  return { pages, complete: discovery.complete && consistent, termination: {
    proof: discovery.completionProof, exhausted: discovery.complete,
    reason: consistent ? discovery.reason : "catalog_count_mismatch",
    method: "observed site method with original collectProductUrls and discoverCatalog",
    evidence: ["catalog-discovery.json", "catalog-preparation.json", "catalog-script-use.json"],
    zeroGrowthRounds: discovery.zeroGrowthRounds,
    oracle: { expected: oracle.expected ?? null, observed, comparable: oracle.comparable },
  } };
}
