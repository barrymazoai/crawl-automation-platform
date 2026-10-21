/**
 * Owner 2026-10-20 (DTC step 1): replays the DTC platform reader over the agent's retained product pages, offline.
 * Reads files only: no browser, no model, no database, no network. For each retained capture it reports whether the
 * reader recognises the page, finds a facts block, how many original images and variants it sees, and how that
 * compares with what the agent recorded for the same page.
 *
 * Usage: tsx tools/replay-dtc-platform-read.mts <dtc-native root> <new output dir> [limit] [--embed-platform-json]
 *
 * `--embed-platform-json` adds the platform product JSON the agent fetched for the same page (its `native-originals`
 * receipt of kind `json`) to the retained HTML as the capture's preparation script now does live, so the replay shows
 * the reader with the data it will actually have.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDtcProduct } from "../packages/channels/dtc/src/product.js";
import { dtcSitePolicy } from "../packages/channels/dtc/src/site-policy.js";
import { platformHint } from "../packages/channels/dtc/src/analysis/data.js";
import { completeFacts } from "../packages/channels/core/src/platforms/content.js";
import { errorCodeOf } from "../packages/platform/src/errors/error-code.js";

const args = process.argv.slice(2);
const embedPlatformJson = args.includes("--embed-platform-json");
const [root, output, limitArg] = args.filter((arg) => !arg.startsWith("--"));
if (!root || !output) {
  throw new Error("Usage: <dtc-native root> <new output dir> [limit] [--embed-platform-json]");
}
const limit = limitArg ? Number(limitArg) : Number.POSITIVE_INFINITY;
await mkdir(output, { mode: 0o700 }); // An existing output directory is never overwritten.

interface Row {
  task: string;
  site: string;
  platform: string;
  url: string;
  status: string;
  message?: string;
  facts?: boolean;
  factsComplete?: boolean;
  images?: number;
  agentImages?: number;
  variants?: number;
  agentVariants?: number;
  categories?: number;
  selectedVariant?: string | null;
  platformJson?: boolean;
}

const rows: Row[] = [];
const tasks = (await readdir(root)).sort();
for (const task of tasks) {
  if (rows.length >= limit) {
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
    rows.push({ task, site: hostname(url), platform: "?", url, status: "NO_RETAINED_PAGE" });
    continue;
  }
  const retained = await readFile(htmlFile, "utf8");
  const platformJson = embedPlatformJson ? await retainedPlatformJson(join(root, task), url) : null;
  const html = platformJson ? embed(retained, platformJson) : retained;
  const site = hostname(url);
  const platform = platformHint({ url, html, archiveKey: "" });
  const policy = dtcSitePolicy({ siteKey: site, platform, catalogUrl: null });
  const agentImages = Array.isArray(record.gallery) ? record.gallery.length : 0;
  const agentVariants = Array.isArray(record.variants) ? record.variants.length : 0;
  try {
    const product = readDtcProduct({ url, html, capturedAt: new Date().toISOString() }, [policy]);
    rows.push({
      task,
      site,
      platform,
      url,
      status: "read",
      facts: product.factsHtml !== null,
      factsComplete: completeFacts(product.factsHtml).complete,
      images: product.images.length,
      agentImages,
      variants: product.variants.length,
      agentVariants,
      categories: product.categories?.length ?? 0,
      selectedVariant: product.selectedVariantId,
      platformJson: platformJson !== null,
    });
  } catch (error) {
    rows.push({
      task,
      site,
      platform,
      url,
      status: errorCodeOf(error) ?? "ERROR",
      message: String(error instanceof Error ? error.message : error).slice(0, 200),
      agentImages,
      agentVariants,
      platformJson: platformJson !== null,
    });
  }
}

const bySite = new Map<string, Row[]>();
for (const row of rows) {
  bySite.set(row.site, [...(bySite.get(row.site) ?? []), row]);
}
const summary = [...bySite.entries()]
  .map(([site, list]) => {
    const read = list.filter((row) => row.status === "read");
    const codes = Object.fromEntries(
      [...new Set(list.filter((row) => row.status !== "read").map((row) => row.status))].map(
        (code) => [code, list.filter((row) => row.status === code).length],
      ),
    );
    return {
      site,
      platform: list[0]?.platform ?? "?",
      pages: list.length,
      read: read.length,
      facts: read.filter((row) => row.facts).length,
      factsComplete: read.filter((row) => row.factsComplete).length,
      singleVariant: read.filter((row) => row.variants === 1).length,
      variantsMatchAgent: read.filter((row) => row.variants === row.agentVariants).length,
      imagesAtLeastAgent: read.filter((row) => (row.images ?? 0) >= (row.agentImages ?? 0)).length,
      medianImages: median(read.map((row) => row.images ?? 0)),
      medianAgentImages: median(read.map((row) => row.agentImages ?? 0)),
      failures: codes,
    };
  })
  .sort((left, right) => right.pages - left.pages);

await writeFile(join(output, "rows.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
const table = [
  "| site | platform | pages | read | facts | facts complete | single variant | variants = agent | images ≥ agent | median images (reader / agent) | failures |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...summary.map(
    (entry) =>
      `| ${entry.site} | ${entry.platform} | ${entry.pages} | ${entry.read} | ${entry.facts} | ${entry.factsComplete} | ${entry.singleVariant} | ${entry.variantsMatchAgent} | ${entry.imagesAtLeastAgent} | ${entry.medianImages} / ${entry.medianAgentImages} | ${Object.entries(entry.failures).map(([code, count]) => `${code} ${count}`).join(", ") || "-"} |`,
  ),
].join("\n");
await writeFile(join(output, "summary.md"), table + "\n", { flag: "wx" });
console.log(table);

/** The agent's retained `<product>.json` response for this page, when it fetched one (receipt kind `json`). */
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
    const receipt = JSON.parse(await readFile(join(originals, name), "utf8")) as {
      kind?: string;
      url?: string;
      path?: string;
    };
    const target = receipt.url ? new URL(receipt.url).pathname : "";
    if (receipt.kind === "json" && receipt.path && (target === `${path}.json` || target === `${path}.js`)) {
      const file = join(task, receipt.path);
      return (await exists(file)) ? readFile(file, "utf8") : null;
    }
  }
  return null;
}

/** What the live preparation script does: the platform JSON as one more JSON script at the end of the body. */
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
