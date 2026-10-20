/**
 * Owner 2026-10-20 (DTC step 1): replays the DTC platform reader over the agent's retained product pages, offline.
 * Reads files only: no browser, no model, no database, no network. For each retained capture it reports whether the
 * reader recognises the page, finds a facts block, how many original images and variants it sees, and how that
 * compares with what the agent recorded for the same page.
 *
 * Usage: tsx tools/replay-dtc-platform-read.mts <dtc-native root> <new output dir> [limit]
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDtcProduct } from "../packages/channels/dtc/src/product.js";
import { dtcSitePolicy } from "../packages/channels/dtc/src/site-policy.js";
import { platformHint } from "../packages/channels/dtc/src/analysis/data.js";
import { completeFacts } from "../packages/channels/core/src/platforms/content.js";
import { errorCodeOf } from "../packages/platform/src/errors/error-code.js";

const [root, output, limitArg] = process.argv.slice(2);
if (!root || !output) {
  throw new Error("Usage: <dtc-native root> <new output dir> [limit]");
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
  const html = await readFile(htmlFile, "utf8");
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
