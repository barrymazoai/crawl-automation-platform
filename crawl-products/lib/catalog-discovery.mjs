import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectProductUrls } from "./crawl.mjs";
import { enumerateCatalog } from "./catalog-enumeration.mjs";
import { captureShopifyCatalogCoverage } from "./catalog-shopify.mjs";
import { dtcCatalogCoverageTarget } from "./catalog-coverage.mjs";
import { retainCatalogProfile } from "./catalog-profile.mjs";

/** The old ENUMERATE-to-fixpoint phase alone. Never extracts products or interprets pictures. */
export async function discoverCatalog(tab, seedUrls, options = {}) {
  if (!options.outDir) throw new Error("catalog_out_dir_required");
  if (tab.captureMode === "catalog" && !(options.productLinkSelectors ?? []).some(selector =>
    typeof selector === "string" && selector.trim() && selector.length <= 240
  )) throw new Error("catalog_product_link_mapping_required");
  const maxRounds = options.maxRounds ?? 10;
  if (!Number.isInteger(maxRounds) || maxRounds < 2 || maxRounds > 100) throw new Error("catalog_round_limit_invalid");
  const completionProof = options.completionProof ?? "enumeration";
  if (!["enumeration", "shopify"].includes(completionProof)) throw new Error("catalog_proof_invalid");
  if (completionProof === "shopify" && (seedUrls.length !== 1 || !dtcCatalogCoverageTarget(seedUrls[0]) || !options.catalogRoot)) {
    throw new Error("catalog_shopify_scope_invalid");
  }
  const requiredZeroGrowthRounds = options.extraRoundsAfterConverge ?? 1;
  if (!Number.isInteger(requiredZeroGrowthRounds) || requiredZeroGrowthRounds < 1 || requiredZeroGrowthRounds > 100) throw new Error("catalog_fixpoint_invalid");
  if (tab.captureMode === "catalog") {
    const coverage = options.listingCoverage;
    if (!Array.isArray(coverage) || seedUrls.some(url => !coverage.some(item =>
      item.url === url && item.verifiedVisually === true && ["none", "link", "click", "scroll"].includes(item.paginationMode)
    ))) throw new Error("catalog_pagination_mapping_required_before_capture");
    if (typeof options.profileDir !== "string" || !options.profileDir.trim()) throw new Error("catalog_profile_dir_required");
    await tab.beginCatalog(options.outDir);
  }
  await mkdir(options.outDir, { recursive: true });
  const method = tab.captureMode === "catalog" ? await retainCatalogProfile(seedUrls, options) : null;
  const progressPath = join(options.outDir, "catalog-progress.jsonl");
  await writeFile(progressPath, "", { flag: "wx" });
  const progress = async (event, details) => {
    const entry = { event, observedAt: new Date().toISOString(), ...details };
    await appendFile(progressPath, JSON.stringify(entry) + "\n");
    options.log?.(event, entry);
  };
  const observedUrls = new Set();
  const enumerate = options.enumerate ?? collectProductUrls;
  const found = new Set();
  const result = { codec: "catalog-discovery/1", completionProof, requiredZeroGrowthRounds, seedUrls, method, pages: [], rounds: [],
    productUrls: [], zeroGrowthRounds: 0, complete: false, reason: "round_limit" };
  const startedAt = Date.now();
  try {
    await progress("enumerate_started", { seedUrls, completionProof });
    const enumeration = await enumerateCatalog(seedUrls, {
      found, maxRounds, extraRoundsAfterConverge: requiredZeroGrowthRounds,
      enumerateOptions: options,
      budgetBreach: () => Date.now() - startedAt > (options.wallClockMinutes ?? 10) * 60_000 ? "wall_clock_budget" : null,
      enumerate: (seeds, enumerateOptions, round) => enumerate(tab, seeds, {
        ...enumerateOptions,
        stayInCatalogPath: tab.captureMode === "catalog",
        onListingPage: async page => {
          const prefix = `catalog-round-${round}-page-${result.pages.length + 1}`;
          const htmlPath = `${prefix}.html`, screenshotPath = `${prefix}.png`;
          const html = await tab.playwright.evaluate(() => document.documentElement.outerHTML);
          await writeFile(join(options.outDir, htmlPath), html, { flag: "wx" });
          await tab.screenshot({ path: join(options.outDir, screenshotPath) });
          result.pages.push({ ...page, round, htmlPath, screenshotPath });
          for (const url of page.productUrls) observedUrls.add(url);
          await progress("enumerate_page_saved", { round, page: result.pages.length,
            url: page.url, products: page.productUrls.length, observed: observedUrls.size,
            htmlPath, screenshotPath });
        },
      }),
      onRound: async report => {
        result.rounds.push(report);
        result.productUrls = report.productUrls;
        result.zeroGrowthRounds = report.coverageComplete && report.growth === 0 ? result.zeroGrowthRounds + 1 : 0;
        await progress("enumerate_round", { round: report.round, growth: report.growth,
          coverageComplete: report.coverageComplete, discovered: found.size,
          zeroGrowthRounds: result.zeroGrowthRounds });
      },
      verifyCompleteRound: completionProof === "shopify" ? async report => {
        await captureShopifyCatalogCoverage(tab, seedUrls[0], options, report.productUrls.map(url => ({ url })));
        return true;
      } : undefined,
    });
    result.complete = enumeration.complete;
    result.reason = enumeration.complete
      ? completionProof === "shopify" ? "verified_shopify_catalog" : "verified_zero_growth"
      : enumeration.reason;
    return result;
  } catch (error) {
    result.reason = `discovery_failed:${String(error)}`;
    throw error;
  } finally {
    await writeFile(join(options.outDir, "catalog-discovery.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    await progress("enumerate_finished", { complete: result.complete, reason: result.reason,
      pages: result.pages.length, observed: observedUrls.size });
  }
}
