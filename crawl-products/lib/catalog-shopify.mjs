import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dtcCatalogCoverageTarget, verifyDtcCatalogCoverage } from "./catalog-coverage.mjs";

/** Obtain the old bounded oracle through the current task's native browser API. */
export async function captureShopifyCatalogCoverage(tab, url, options, entries) {
  const target = dtcCatalogCoverageTarget(url);
  if (!target || !options.catalogRoot) throw new Error("catalog_shopify_scope_invalid");
  const proof = { version: target.version, catalogUrl: url, dom: null, responses: [] };
  try {
    const dom = await tab.playwright.evaluate(selector => {
      const root = document.querySelector(selector);
      if (!root) throw new Error("catalog_root_missing");
      return { url: location.href, links: [...root.querySelectorAll("a[href]")].map(anchor => anchor.href), html: document.documentElement.outerHTML };
    }, options.catalogRoot);
    proof.dom = { url: dom.url, links: dom.links };
    const evidence = { catalogRoot: options.catalogRoot, htmlPath: "catalog-shopify-dom.html", screenshotPath: "catalog-shopify-dom.png" };
    await writeFile(join(options.outDir, evidence.htmlPath), dom.html, { flag: "wx" });
    await tab.screenshot({ path: join(options.outDir, evidence.screenshotPath) });
    await writeFile(join(options.outDir, "catalog-coverage-evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
    if (dom.url !== url || dom.links.length > 1000) throw new Error("DTC.CATALOG_END_UNVERIFIED");
    for (let index = 1; index <= 2; index++) {
      const endpoint = `${target.endpoint}?limit=100&page=${index}`;
      const response = await tab.playwright.evaluate(async endpoint => {
        const control = new AbortController(), timer = setTimeout(() => control.abort(), 10000);
        try {
          const response = await fetch(endpoint, { credentials: "include", redirect: "error", signal: control.signal, headers: { accept: "application/json" } });
          return { url: response.url, status: response.status, contentType: response.headers.get("content-type") || "", body: await response.text() };
        } finally { clearTimeout(timer); }
      }, endpoint);
      // Save each response before parsing; errors and malformed bodies remain evidence.
      await writeFile(join(options.outDir, `catalog-shopify-response-${index}.json`), JSON.stringify(response), { flag: "wx" });
      proof.responses.push(response);
      if (response.status !== 200 || response.body.length > 524288 || !/json/i.test(response.contentType)) throw new Error("DTC.CATALOG_END_UNVERIFIED");
      const data = JSON.parse(response.body);
      if (!Array.isArray(data.products)) throw new Error("DTC.CATALOG_END_UNVERIFIED");
      if (data.products.length === 0) break;
    }
    verifyDtcCatalogCoverage(proof, url, entries);
    return proof;
  } finally {
    await writeFile(join(options.outDir, "catalog-coverage.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
  }
}
