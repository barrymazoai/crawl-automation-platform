import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEgoBrowser } from "./ego-native-browser.mjs";
import { runHarvest } from "./run-harvest.mjs";
import { withNativeExtractionBoundary } from "./native-extraction-boundary.mjs";
import { normalizePlatformVariants } from "./platform-variants.mjs";
import { assertMaterialVariantIds } from "./material-variants.mjs";
import { missingSiteMethodFields, repeatedSiteMethodMaterialIds } from "./site-method-record.mjs";
import { declaredProductGallery } from "./declared-product-images.mjs";

/** Stable host launcher around the original harvest. Only the learned site method varies. */
export async function runSiteCapture(input, globals) {
  const { cwd, outDir, productUrl, methodPath, taskSpaceId, label, targetId, skillRoot } = input;
  const task = await globals.taskSpace(taskSpaceId);
  const page = await task.page(label);
  const browser = createEgoBrowser({ task, page, targetId, listTaskSpaces: globals.listTaskSpaces,
    workDir: cwd, productUrl, captureMode: "product" });
  let observedVariants;
  const fetchProductSource = browser.harvestHooks.fetchProductSource;
  browser.harvestHooks.fetchProductSource = async url => {
    const source = await fetchProductSource(url);
    if (source?.product) observedVariants = normalizePlatformVariants(source.product, url);
    return source;
  };
  const source = await readFile(methodPath);
  const digest = createHash("sha256").update(source).digest("hex");
  const method = await import(pathToFileURL(methodPath).href);
  if (typeof method.capture !== "function") throw new Error("site_method_capture_export_required");
  const captured = await withNativeExtractionBoundary(true, () => method.capture({
    browser, tab: browser.tab, page, productUrl, outDir, skillRoot,
  }));
  if (captured?.record?.sourceUrl !== productUrl || !captured.record.fields
    || !captured.materials || !Array.isArray(captured.galleryUrls) || !captured.galleryUrls.length) {
    throw new Error("site_method_product_output_invalid");
  }
  const missing = missingSiteMethodFields(captured.record, productUrl, captured.galleryUrls);
  if (missing.length) {
    // Still before runHarvest/checkpoint: the agent can repair this learned step locally.
    throw new Error(`site_method_required_fields_missing:${missing.join(",")}`);
  }
  if (Object.keys(captured.record.fields).some(key => !["title", "brand", "currency"].includes(key))) {
    throw new Error("capture_contains_parsed_product_fields");
  }
  assertMaterialVariantIds(captured.record.variants ?? [], captured.materials, observedVariants);
  const repeated = await repeatedSiteMethodMaterialIds(captured.materials, captured.notes,
    captured.record, path => readFile(join(outDir, path), "utf8"));
  if (repeated.length) {
    // The region can be fixed in the learned method before any harvest/checkpoint is written.
    throw new Error(`site_method_product_html_repeated_ids:${JSON.stringify(repeated)}: each id occurs once on `
      + "the full page but more than once in productHtml, so the method saved the same page element twice. Usually "
      + "one saved node lies inside another saved node (deduplicating by node identity does not catch this); keep "
      + "the outer node or drop the nested selection.");
  }
  if (!source.equals(await readFile(methodPath))) throw new Error("site_method_changed_during_capture");
  // Owner 2026-10-24: use the full page's own Product declarations. Retain those same
  // page bytes in runHarvest; the region HTML alone may omit structured data.
  let gallery = { urls: captured.galleryUrls, replacements: [] };
  const fetchPageHtml = browser.harvestHooks.fetchPageHtml;
  if (captured.galleryUrls.some(url => /resized_\d+_\d+_/i.test(url))
    && typeof fetchPageHtml === "function") {
    try {
      const html = await fetchPageHtml(productUrl);
      if (typeof html === "string") {
        gallery = declaredProductGallery(html, productUrl, captured.galleryUrls);
        browser.harvestHooks.fetchPageHtml = url =>
          url === productUrl ? Promise.resolve(html) : fetchPageHtml(url);
      }
    } catch { /* keep the observed gallery when the optional larger source is unavailable */ }
  }
  // The original gallery URLs stay visible in the page HTML and capture-notes substitution map.
  const upgradedUrl = new Map(gallery.replacements.map(item => [item.galleryUrl, item.declaredUrl]));
  const upgradeList = urls => [...new Set(urls.map(url => upgradedUrl.get(url) ?? url))];
  captured.galleryUrls = gallery.urls;
  captured.materials.variants = captured.materials.variants.map(scope =>
    Array.isArray(scope.galleryUrls) ? { ...scope, galleryUrls: upgradeList(scope.galleryUrls) } : scope);
  // Preserve the exact executed method alongside the old raw output, before any post-capture work.
  await writeFile(join(outDir, "site-method.mjs"), source, { flag: "wx" });
  await writeFile(join(outDir, "method-use.json"), JSON.stringify({
    codec: "dtc-site-method-use/1", origin: new URL(productUrl).origin, productUrl,
    sha256: digest, path: "site-method.mjs",
  }), { flag: "wx" });
  await writeFile(join(outDir, "capture-notes.json"), JSON.stringify({ ...captured.notes,
    galleryUpgrades: gallery.replacements }), { flag: "wx" });
  await writeFile(join(outDir, "materials.json"), JSON.stringify(captured.materials), { flag: "wx" });
  const plan = {
    site: { origin: new URL(productUrl).origin, entryUrl: productUrl, browserMode: "ego-native" },
    decision: { kind: "storefront", evidence: ["host-dispatched-product"] },
    route: { listingSeeds: [{ url: productUrl, paginationMode: "none" }], detailProfile: { fields: {} } },
    termination: { perSeed: [{ url: productUrl, exhaustionSignal: "single_page_confirmed" }], oracles: [] },
  };
  return runHarvest(browser, browser.tab, plan, {
    outDir, observedGalleryUrls: captured.galleryUrls,
    hooks: { extract: async () => ({ records: [captured.record], needsUpgrade: [], failed: [] }) },
    log: (event, details) => console.log(JSON.stringify({ event, details })),
  });
}
