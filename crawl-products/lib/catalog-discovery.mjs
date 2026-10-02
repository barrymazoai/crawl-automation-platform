import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectProductUrls } from "./crawl.mjs";

/** The old ENUMERATE-to-fixpoint phase alone. Never extracts products or interprets pictures. */
export async function discoverCatalog(tab, seedUrls, options = {}) {
  if (!options.outDir) throw new Error("catalog_out_dir_required");
  const maxRounds = options.maxRounds ?? 10;
  if (!Number.isInteger(maxRounds) || maxRounds < 2 || maxRounds > 100) throw new Error("catalog_round_limit_invalid");
  await mkdir(options.outDir, { recursive: true });
  const enumerate = options.enumerate ?? collectProductUrls;
  const found = new Set();
  const result = { codec: "catalog-discovery/1", seedUrls, pages: [], rounds: [],
    productUrls: [], zeroGrowthRounds: 0, complete: false, reason: "round_limit" };
  const startedAt = Date.now();
  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (Date.now() - startedAt > (options.wallClockMinutes ?? 10) * 60_000) {
        result.reason = "wall_clock_budget";
        break;
      }
      const before = found.size;
      const observed = await enumerate(tab, seedUrls, {
        // Each verification round must walk the catalog again. Passing prior URLs to
        // the legacy collector can stop after two already-known pagination pages.
        ...options, known: [], knownInlineRecords: [],
        onListingPage: async page => {
          const prefix = `catalog-round-${round}-page-${result.pages.length + 1}`;
          const htmlPath = `${prefix}.html`, screenshotPath = `${prefix}.png`;
          const html = await tab.playwright.evaluate(() => document.documentElement.outerHTML);
          await writeFile(join(options.outDir, htmlPath), html, { flag: "wx" });
          await tab.screenshot({ path: join(options.outDir, screenshotPath) });
          result.pages.push({ ...page, round, htmlPath, screenshotPath });
        },
      });
      for (const url of observed.productUrls ?? []) found.add(url);
      const growth = found.size - before;
      const coverageComplete = observed.coverage?.status === "complete";
      result.rounds.push({ round, growth, productUrls: [...found], coverageComplete,
        seedReports: observed.coverage?.seedReports ?? [] });
      result.productUrls = [...found];
      options.log?.("enumerate_round", { round, growth, discovered: found.size, coverageComplete });
      if (!coverageComplete) {
        result.reason = "coverage_incomplete";
        break;
      }
      result.zeroGrowthRounds = growth === 0 ? result.zeroGrowthRounds + 1 : 0;
      if (round >= 2 && result.zeroGrowthRounds >= 1) {
        result.complete = true;
        result.reason = "verified_zero_growth";
        break;
      }
    }
    return result;
  } catch (error) {
    result.reason = `discovery_failed:${String(error)}`;
    throw error;
  } finally {
    await writeFile(join(options.outDir, "catalog-discovery.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  }
}
