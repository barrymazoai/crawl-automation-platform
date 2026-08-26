import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  writeEnrichProductExport,
} from "../crawl-products/lib/enrich-product-output.mjs";
import {
  matchHealthFunction,
} from "../crawl-products/lib/health-function-vocab.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.dirname(scriptDir);
const legacyMap = JSON.parse(await fs.readFile(
  path.join(scriptDir, "legacy-health-function-map.json"),
  "utf8",
));
const priceOverrides = JSON.parse(await fs.readFile(
  path.join(scriptDir, "legacy-price-overrides.json"),
  "utf8",
));

const archives = [
  {
    label: "first40",
    path: "/Users/songtianjian/Downloads/crawl-100-sites-terminal-40-verified.zip",
  },
  {
    label: "remaining82",
    path: "/Users/songtianjian/Downloads/crawl-remaining-82-sites-results-full.zip",
  },
  {
    label: "rerun42",
    path: "/Users/songtianjian/Downloads/crawl-42-rerun-results-2026-08-11.zip",
  },
  {
    label: "final30",
    path: "/Users/songtianjian/Downloads/crawl-30-final-runs-2026-08-12-verified.zip",
  },
];

function unzip(args, options = {}) {
  return execFileSync("unzip", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  });
}

function archiveEntries(zipPath) {
  return unzip(["-Z1", zipPath])
    .split(/\r?\n/)
    .filter(Boolean);
}

function normalizedEntry(entry) {
  return entry.replaceAll("\\", "/");
}

function siteFromEntry(entry) {
  const normalized = normalizedEntry(entry);
  const parts = normalized.split("/");
  const runsIndex = parts.indexOf("runs");
  return runsIndex >= 0 ? parts[runsIndex + 1] : parts[0];
}

function readSiteFile(archive, site, fileName) {
  const pattern = `*${site}*${fileName}`;
  try {
    return unzip(["-p", archive.path, pattern]);
  } catch (error) {
    if (error?.status === 11) return "";
    throw error;
  }
}

function readSiteJson(archive, site, fileName, fallback = null) {
  const raw = readSiteFile(archive, site, fileName);
  return raw.trim() ? JSON.parse(raw) : fallback;
}

function productCount(products) {
  if (Array.isArray(products)) return products.length;
  if (Array.isArray(products?.products)) return products.products.length;
  return 0;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function canonicalTargets(value) {
  const direct = matchHealthFunction(value);
  if (direct) return [direct.name];
  return legacyMap[value] ?? [];
}

function inferenceValues(record) {
  const values = record?._meta?.semanticInferences?.health_function;
  return Array.isArray(values) ? values : [];
}

function normalizeHealthFunctions(record, siteReport) {
  const fields = record.fields && typeof record.fields === "object"
    ? record.fields
    : record;
  const rawValues = fields.health_function ?? fields.healthFunctions
    ?? record.health_function ?? record.healthFunctions ?? [];
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  const sourceInferences = inferenceValues(record);
  const normalizedValues = [];
  const normalizedInferences = [];

  for (const rawValue of values) {
    const targets = canonicalTargets(rawValue);
    if (targets.length === 0) {
      siteReport.unmappedHealthFunctions.add(String(rawValue));
      continue;
    }
    const sourceInference = sourceInferences.find((item) =>
      String(item?.value ?? "").toLocaleLowerCase()
        === String(rawValue).toLocaleLowerCase());
    for (const target of targets) {
      const canonical = matchHealthFunction(target);
      if (!canonical) {
        throw new Error(`invalid canonical health function mapping: ${rawValue} -> ${target}`);
      }
      normalizedValues.push(canonical.name);
      if (sourceInference) {
        normalizedInferences.push({
          ...sourceInference,
          value: canonical.name,
          normalizedFrom: String(rawValue),
        });
      }
      if (canonical.name !== rawValue) {
        siteReport.healthFunctionNormalizations.add(
          `${rawValue} -> ${canonical.name}`,
        );
      }
    }
  }

  fields.health_function = unique(normalizedValues);
  delete fields.healthFunctions;
  if (record._meta?.semanticInferences) {
    record._meta.semanticInferences.health_function = uniqueByValue(
      normalizedInferences,
    );
  }
  return record;
}

function uniqueByValue(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = String(item?.value ?? "").toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function recordPrice(record) {
  const fields = record.fields && typeof record.fields === "object"
    ? record.fields
    : record;
  const direct = fields.price ?? fields.retail_price
    ?? record.price ?? record.retail_price;
  if (String(direct ?? "").trim()) return String(direct).trim();
  const variants = Array.isArray(record.variants)
    ? record.variants
    : Array.isArray(fields.variants) ? fields.variants : [];
  const preferred = variants.find((variant) => variant?.available !== false)
    ?? variants[0];
  return String(preferred?.price ?? "").trim();
}

function missingPriceEntry(record, index) {
  const fields = record.fields ?? record;
  return {
    index,
    productName: fields.title ?? fields.productName ?? null,
    productUrl: fields.productUrl ?? fields.product_url ?? fields.url
      ?? record.productUrl ?? record.product_url ?? record.sourceUrl ?? null,
  };
}

function recordUrl(record) {
  const fields = record.fields ?? record;
  return fields.productUrl ?? fields.product_url ?? fields.url
    ?? record.productUrl ?? record.product_url ?? record.sourceUrl ?? null;
}

function applyPriceOverride(record, siteReport) {
  const productUrl = recordUrl(record);
  const override = priceOverrides[productUrl];
  if (!override) return record;
  const fields = record.fields && typeof record.fields === "object"
    ? record.fields
    : record;
  fields.price = override.price;
  fields.currency ??= override.currency;
  fields.sku ??= override.sku;
  fields.availability = override.available ? "InStock" : "OutOfStock";
  if (!Array.isArray(record.variants) || record.variants.length === 0) {
    record.variants = [{
      variantId: override.variantId,
      sku: override.sku,
      title: "Default Title",
      options: {},
      price: override.price,
      available: override.available,
      url: productUrl,
    }];
  }
  record._meta ??= {};
  record._meta.priceRefresh = {
    source: override.source,
    observedAt: override.observedAt,
    currency: override.currency,
  };
  siteReport.priceOverrides.push({
    productUrl,
    price: override.price,
    currency: override.currency,
    source: override.source,
  });
  return record;
}

async function latestSiteRuns() {
  const latest = new Map();
  for (const [rank, archive] of archives.entries()) {
    await fs.access(archive.path);
    const stateEntries = archiveEntries(archive.path)
      .filter((entry) => normalizedEntry(entry).endsWith("/state.json"));
    for (const entry of stateEntries) {
      const site = siteFromEntry(entry);
      const state = readSiteJson(archive, site, "state.json", {});
      const products = readSiteJson(archive, site, "products.json", []);
      latest.set(site, {
        archive,
        rank,
        site,
        state: state?.state ?? "missing",
        productCount: productCount(products),
      });
    }
  }
  return [...latest.values()];
}

function serializableSiteReport(report) {
  return {
    ...report,
    healthFunctionNormalizations: [...report.healthFunctionNormalizations].sort(),
    unmappedHealthFunctions: [...report.unmappedHealthFunctions].sort(),
  };
}

const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputRoot = outputArg
  ? path.resolve(outputArg.slice("--output=".length))
  : path.join(workspace, "output", "offline-upgrade-48-20260815");
await fs.mkdir(outputRoot, { recursive: true });

const runs = await latestSiteRuns();
const selected = runs
  .filter((run) => run.rank < archives.length - 1)
  .filter((run) => ["complete", "verified"].includes(run.state))
  .filter((run) => run.productCount > 0)
  .sort((a, b) => a.site.localeCompare(b.site));

if (selected.length !== 48) {
  throw new Error(`expected 48 legacy non-empty sites, found ${selected.length}`);
}

const batch = {
  generatedAt: new Date().toISOString(),
  outputMode: "offline_legacy_upgrade",
  sourceSites: selected.length,
  sourceBaseRecords: 0,
  variantExpandedInputs: 0,
  completeSites: 0,
  incompleteSites: 0,
  formalBatchArtifactsWritten: false,
  sites: [],
};
const missingPrices = [];
const batchCandidates = [];

for (const run of selected) {
  const rawRecords = readSiteJson(
    run.archive,
    run.site,
    "crawl-records.json",
    [],
  );
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    throw new Error(`missing crawl records for ${run.site}`);
  }

  const siteReport = {
    site: run.site,
    sourceArchive: run.archive.path,
    sourceBatch: run.archive.label,
    sourceState: run.state,
    sourceProductRows: run.productCount,
    sourceBaseRecords: rawRecords.length,
    healthFunctionNormalizations: new Set(),
    unmappedHealthFunctions: new Set(),
    priceOverrides: [],
    missingPrices: [],
  };
  const migratedRecords = structuredClone(rawRecords).map((record, index) => {
    normalizeHealthFunctions(record, siteReport);
    applyPriceOverride(record, siteReport);
    if (!recordPrice(record)) {
      const gap = missingPriceEntry(record, index);
      siteReport.missingPrices.push(gap);
      missingPrices.push({ site: run.site, ...gap });
    }
    return record;
  });

  const siteOut = path.join(outputRoot, "sites", run.site);
  const exported = await writeEnrichProductExport(siteOut, migratedRecords, {
    domain: run.site,
    processedAt: batch.generatedAt,
    updateExisting: true,
    runCompletion: { status: "complete" },
  });
  const status = exported.summary.formalArtifactsWritten === true
    ? "complete"
    : "incomplete";
  siteReport.status = status;
  siteReport.exportSummary = exported.summary;
  siteReport.errorCount = exported.errors.length;
  siteReport.reviewCount = exported.reviewQueue.length;
  siteReport.outputDirectory = siteOut;
  await fs.writeFile(
    path.join(siteOut, "offline-migration-report.json"),
    `${JSON.stringify(serializableSiteReport(siteReport), null, 2)}\n`,
  );

  batch.sourceBaseRecords += rawRecords.length;
  batch.variantExpandedInputs += exported.inputs.length;
  batch[status === "complete" ? "completeSites" : "incompleteSites"] += 1;
  batch.sites.push(serializableSiteReport(siteReport));
  batchCandidates.push(...exported.requests.map((request) => ({
    site: run.site,
    status,
    ...request,
  })));
}

batch.status = batch.incompleteSites === 0 ? "complete" : "incomplete";
batch.blockingReasons = [
  ...(batch.incompleteSites > 0 ? ["one_or_more_sites_incomplete"] : []),
  ...(missingPrices.length > 0 ? ["missing_current_or_captured_price"] : []),
];

await Promise.all([
  fs.writeFile(
    path.join(outputRoot, "batch-report.json"),
    `${JSON.stringify(batch, null, 2)}\n`,
  ),
  fs.writeFile(
    path.join(outputRoot, "missing-price-refresh.json"),
    `${JSON.stringify(missingPrices, null, 2)}\n`,
  ),
  fs.writeFile(
    path.join(outputRoot, "api-ready-candidates.json"),
    `${JSON.stringify(batchCandidates, null, 2)}\n`,
  ),
]);

process.stdout.write(`${JSON.stringify({
  outputRoot,
  status: batch.status,
  sourceSites: batch.sourceSites,
  sourceBaseRecords: batch.sourceBaseRecords,
  variantExpandedInputs: batch.variantExpandedInputs,
  completeSites: batch.completeSites,
  incompleteSites: batch.incompleteSites,
  missingPriceRecords: missingPrices.length,
}, null, 2)}\n`);
