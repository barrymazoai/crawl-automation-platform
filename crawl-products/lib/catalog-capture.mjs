import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { createEgoBrowser } from "./ego-native-browser.mjs";
import { discoverCatalog } from "./catalog-discovery.mjs";
import { normalizeProductUrl } from "./engine.mjs";
import { slugTitle } from "./catalog-kit.mjs";

const exists = (path) => access(path).then(() => true, () => false);
const ATTEMPT_FILES = ["catalog-method.mjs", "catalog-script-use.json", "catalog-preparation.json",
  "catalog-preparation.html", "catalog-preparation.png"];

/**
 * One more launch is allowed after a script error before browsing started (owner 2026-10-06): the first attempt's
 * files move to attempt-1/. Once enumeration started, or after a second attempt, the launcher refuses.
 */
async function keepEarlierAttempt(outDir) {
  if (!await exists(join(outDir, "catalog-script-use.json"))) return;
  if (await exists(join(outDir, "catalog-progress.jsonl"))) throw new Error("catalog_rerun_after_enumeration");
  const attempt = join(outDir, "attempt-1");
  if (await exists(attempt)) throw new Error("catalog_attempts_exhausted");
  await mkdir(attempt);
  for (const name of ATTEMPT_FILES) {
    if (await exists(join(outDir, name))) await rename(join(outDir, name), join(attempt, name));
  }
}

/** The site module supplies observed methods; this launcher owns traversal and output. */
export async function runCatalogCapture(input, globals) {
  const { cwd, outDir, profileDir, sourceUrl, methodPath, taskSpaceId, label, targetId } = input;
  const task = await globals.taskSpace(taskSpaceId);
  const page = await task.page(label);
  const browser = createEgoBrowser({ task, page, targetId, listTaskSpaces: globals.listTaskSpaces,
    workDir: cwd, captureMode: "catalog" });
  const bytes = await readFile(methodPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const method = await import(`${pathToFileURL(methodPath).href}?sha256=${sha256}`);
  if (typeof method.prepare !== "function" || typeof method.projectPage !== "function") {
    throw new Error("catalog_method_exports_required");
  }
  await keepEarlierAttempt(outDir);
  await writeFile(join(outDir, "catalog-method.mjs"), bytes, { flag: "wx" });
  await writeFile(join(outDir, "catalog-script-use.json"), JSON.stringify({
    codec: "dtc-catalog-script-use/1", sourceUrl, sha256,
  }), { flag: "wx" });
  const prepared = await method.prepare({ page, tab: browser.tab, sourceUrl, outDir, navigate: globals.navigate });
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

/** The method's own reading must name exactly the links the enumerator saved for this page. */
function projectionMatches(entries, saved) {
  const expected = new Set(saved.productUrls);
  return Array.isArray(entries) && entries.length === expected.size
    && new Set(entries.map(entry => entry.url)).size === expected.size
    && entries.every(entry => expected.has(entry.url) && entry.title?.trim()
      && (entry.brand === null || typeof entry.brand === "string"));
}

/**
 * When the method cannot read a saved page, the enumerator's own links for it are kept (owner 2026-10-06: usable
 * results are not discarded). Titles come from the saved anchors; brand stays null, so multi-brand sites still need
 * a page brand from the host's check.
 */
function enumeratedEntries(document, saved) {
  const titles = new Map();
  for (const anchor of document.querySelectorAll("a[href]")) {
    let url;
    try { url = normalizeProductUrl(new URL(anchor.getAttribute("href"), saved.url).href); } catch { continue; }
    const text = (anchor.textContent || anchor.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (text && !titles.has(url)) titles.set(url, text);
  }
  return saved.productUrls.map(url => ({ url, title: titles.get(url) || slugTitle(url), brand: null }));
}

async function projectSavedPage({ method, saved, outDir, sourceUrl }) {
  if (!saved.productUrls.length) return { entries: [], warning: null };
  const { document } = parseHTML(await readFile(join(outDir, saved.htmlPath), "utf8"));
  try {
    const entries = await method.projectPage({ document, url: saved.url, sourceUrl });
    if (projectionMatches(entries, saved)) return { entries, warning: null };
    return { entries: enumeratedEntries(document, saved), warning: "catalog_page_projection_mismatch" };
  } catch (error) {
    return { entries: enumeratedEntries(document, saved), warning: `catalog_page_projection_failed:${String(error).slice(0, 200)}` };
  }
}

export async function projectCatalog({ method, discovery, outDir, sourceUrl, oracle }) {
  const pages = [];
  const warnings = [];
  for (const saved of discovery.pages) {
    const { entries, warning } = await projectSavedPage({ method, saved, outDir, sourceUrl });
    if (warning) warnings.push({ page: saved.htmlPath, reason: warning });
    pages.push({ url: saved.url, htmlPath: saved.htmlPath, screenshotPath: saved.screenshotPath, entries });
  }
  const observed = discovery.productUrls.length;
  const consistent = !oracle.comparable || oracle.expected === observed;
  return { pages, warnings, complete: discovery.complete && consistent, termination: {
    proof: discovery.completionProof, exhausted: discovery.complete,
    reason: consistent ? discovery.reason : "catalog_count_mismatch",
    method: "observed site method with original collectProductUrls and discoverCatalog",
    evidence: ["catalog-discovery.json", "catalog-preparation.json", "catalog-script-use.json"],
    zeroGrowthRounds: discovery.zeroGrowthRounds,
    oracle: { expected: oracle.expected ?? null, observed, comparable: oracle.comparable },
  } };
}
