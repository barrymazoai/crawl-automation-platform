/**
 * Owner 2026-10-21 (DTC step 2): replays the platform reader and the DTC evidence over the agent's retained
 * multi-variant product pages, once per variant address (`?variant=<id>`), offline. Files only: no browser, no model,
 * no database, no network. For each variant address it reports whether the reader selects that variant, whether the
 * variant has a featured image, how many gallery images the task's evidence would carry, and the facts block.
 *
 * Usage: tsx tools/replay-dtc-variants.mts <dtc-native root> <new output dir> [limit] [--embed-platform-json]
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDtcProduct } from "../packages/channels/dtc/src/product.js";
import { dtcEvidence } from "../packages/channels/dtc/src/evidence.js";
import { dtcSitePolicy } from "../packages/channels/dtc/src/site-policy.js";
import { platformHint } from "../packages/channels/dtc/src/analysis/data.js";
import { dtcProductAddress } from "../packages/channels/dtc/src/address.js";
import { dtcBrandEvidence } from "../packages/channels/dtc/src/brand-evidence.js";
import { errorCodeOf } from "../packages/platform/src/errors/error-code.js";

const args = process.argv.slice(2);
const embedPlatformJson = args.includes("--embed-platform-json");
const [root, output, limitArg] = args.filter((arg) => !arg.startsWith("--"));
if (!root || !output) {
  throw new Error("Usage: <dtc-native root> <new output dir> [limit] [--embed-platform-json]");
}
const limit = limitArg ? Number(limitArg) : Number.POSITIVE_INFINITY;
await mkdir(output, { mode: 0o700 });

interface Row {
  task: string;
  site: string;
  url: string;
  variantId: string;
  status: string;
  message?: string;
  selected?: string | null;
  selectedMatches?: boolean;
  featured?: boolean;
  evidenceImages?: number;
  ownImages?: number;
  facts?: boolean;
  discovered?: number;
  warnings?: string[];
}

const rows: Row[] = [];
let pages = 0;
let multiVariantPages = 0;
let basePagesWithoutSelection = 0;
for (const task of (await readdir(root)).sort()) {
  if (multiVariantPages >= limit) {
    break;
  }
  const recordsPath = join(root, task, "capture", "evidence", "records.json");
  if (!(await exists(recordsPath))) {
    continue;
  }
  const record = (JSON.parse(await readFile(recordsPath, "utf8")) as Record<string, unknown>[])[0];
  if (!record) {
    continue;
  }
  const url = String(record.productUrl ?? "");
  const htmlPath = join(root, task, "capture", "materials", "page-initial.html");
  const htmlFile = (await exists(htmlPath))
    ? htmlPath
    : join(root, task, "capture", typeof record.pageHtml === "string" ? record.pageHtml : String((record.pageHtml as { localPath?: string })?.localPath ?? ""));
  if (!url || !(await exists(htmlFile))) {
    continue;
  }
  const retained = await readFile(htmlFile, "utf8");
  const platformJson = embedPlatformJson ? await retainedPlatformJson(join(root, task), url) : null;
  const html = platformJson ? embed(retained, platformJson) : retained;
  const site = hostname(url);
  const platform = platformHint({ url, html, archiveKey: "" });
  const policy = dtcSitePolicy({ siteKey: site, platform, catalogUrl: null });
  let base;
  try {
    base = readDtcProduct({ url, html, capturedAt: new Date().toISOString() }, [policy]);
  } catch {
    continue;
  }
  pages++;
  if (base.variants.length <= 1) {
    continue;
  }
  multiVariantPages++;
  if (base.selectedVariantId === null) {
    basePagesWithoutSelection++;
  }
  for (const variant of base.variants) {
    try {
      const product = readDtcProduct({ url: variant.url, html, capturedAt: new Date().toISOString() }, [policy]);
      const evidence = dtcEvidence(product, policy, dtcBrandEvidence(policy, product.brandRaw, null));
      const discovered = product.variants.filter((entry) => entry.id !== product.selectedVariantId).length;
      rows.push({
        task,
        site,
        url: variant.url,
        variantId: variant.id,
        status: "read",
        selected: product.selectedVariantId,
        selectedMatches: product.selectedVariantId === variant.id,
        featured: variant.image !== null,
        evidenceImages: evidence.imageCandidates.length,
        ownImages: evidence.imageCandidates.filter((image) => image.variantId === variant.id).length,
        facts: product.factsHtml !== null,
        discovered,
        warnings: evidence.warnings,
      });
    } catch (error) {
      rows.push({
        task,
        site,
        url: variant.url,
        variantId: variant.id,
        status: errorCodeOf(error) ?? "ERROR",
        message: String(error instanceof Error ? error.message : error).slice(0, 200),
      });
    }
  }
  if (dtcProductAddress(url, [policy]).variantId === null) {
    // The base address itself: what the base task collects.
    rows.push({
      task,
      site,
      url,
      variantId: "(base)",
      status: "read",
      selected: base.selectedVariantId,
      selectedMatches: base.selectedVariantId !== null,
      featured: base.variants.some((entry) => entry.id === base.selectedVariantId && entry.image !== null),
      evidenceImages: dtcEvidence(base, policy, dtcBrandEvidence(policy, base.brandRaw, null)).imageCandidates.length,
      facts: base.factsHtml !== null,
      discovered: base.variants.filter((entry) => entry.id !== base.selectedVariantId).length,
    });
  }
}

const bySite = new Map<string, Row[]>();
for (const row of rows) {
  bySite.set(row.site, [...(bySite.get(row.site) ?? []), row]);
}
const summary = [...bySite.entries()]
  .map(([site, list]) => {
    const variants = list.filter((row) => row.variantId !== "(base)");
    const read = variants.filter((row) => row.status === "read");
    const bases = list.filter((row) => row.variantId === "(base)");
    return {
      site,
      multiVariantPages: bases.length,
      basePagesWithDefault: bases.filter((row) => row.selectedMatches).length,
      variantAddresses: variants.length,
      read: read.length,
      selectedMatches: read.filter((row) => row.selectedMatches).length,
      featured: read.filter((row) => row.featured).length,
      facts: read.filter((row) => row.facts).length,
      medianEvidenceImages: median(read.map((row) => row.evidenceImages ?? 0)),
      failures: Object.fromEntries(
        [...new Set(variants.filter((row) => row.status !== "read").map((row) => row.status))].map((code) => [
          code,
          variants.filter((row) => row.status === code).length,
        ]),
      ),
    };
  })
  .sort((left, right) => right.variantAddresses - left.variantAddresses);

await writeFile(join(output, "rows.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
await writeFile(
  join(output, "summary.json"),
  JSON.stringify({ pages, multiVariantPages, basePagesWithoutSelection, sites: summary }, null, 2),
  { flag: "wx" },
);
const table = [
  `pages read ${pages}, multi-variant ${multiVariantPages}, base pages without a default selection ${basePagesWithoutSelection}`,
  "",
  "| site | multi-variant pages | base has default | variant addresses | read | selected = requested | featured | facts | median evidence images | failures |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...summary.map(
    (entry) =>
      `| ${entry.site} | ${entry.multiVariantPages} | ${entry.basePagesWithDefault} | ${entry.variantAddresses} | ${entry.read} | ${entry.selectedMatches} | ${entry.featured} | ${entry.facts} | ${entry.medianEvidenceImages} | ${Object.entries(entry.failures).map(([code, count]) => `${code} ${count}`).join(", ") || "-"} |`,
  ),
].join("\n");
await writeFile(join(output, "summary.md"), table + "\n", { flag: "wx" });
console.log(table);

async function retainedPlatformJson(task: string, url: string): Promise<string | null> {
  const originals = join(task, "native-originals");
  if (!(await exists(originals))) {
    return null;
  }
  const path = new URL(url).pathname.replace(/\/$/, "");
  for (const name of await readdir(originals)) {
    if (!name.endsWith(".receipt.json")) {
      continue;
    }
    const receipt = JSON.parse(await readFile(join(originals, name), "utf8")) as { kind?: string; url?: string; path?: string };
    const target = receipt.url ? new URL(receipt.url).pathname : "";
    if (receipt.kind === "json" && receipt.path && (target === `${path}.json` || target === `${path}.js`)) {
      const file = join(task, receipt.path);
      return (await exists(file)) ? readFile(file, "utf8") : null;
    }
  }
  return null;
}
function embed(html: string, json: string): string {
  const script = `<script type="application/json" data-crawl-source="shopify-product-js">${json.split("</").join("<\\/")}</script>`;
  const at = html.lastIndexOf("</body>");
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}
function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "?";
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
