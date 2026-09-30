import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProcessRunner } from "@crawl-automation/runtime";
import pg from "pg";
import { z } from "zod";
import { buildAmazonBackfillUnifyInput, missingAmazonProductLineModifiers, type AmazonBackfillSource } from "../src/amazon/backfill.js";
import { AmazonBackfillState } from "../src/amazon/backfill-state.js";
import { completeProductNameWithVariant, runProductUnify, type ProductUnifyResult } from "../src/product-unify.js";

const cliSchema = z.object({
  limit: z.number().int().min(1).max(200).default(20),
  seedLimit: z.number().int().min(1).max(100_000).default(50_000),
  seedOffset: z.number().int().nonnegative().default(0),
  outputDirectory: z.string().min(1),
  stateFile: z.string().min(1),
  seedOnly: z.boolean().default(false),
  retryProduct: z.string().uuid().optional(),
  reconcileReadyText: z.boolean().default(false),
  skipSeed: z.boolean().default(false),
});

function readNumberFlag(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value)) throw new Error(`${name} 必须是整数`);
  return value;
}

const cli = cliSchema.parse({
  limit: readNumberFlag("--limit", 20),
  seedLimit: readNumberFlag("--seed-limit", 50_000),
  seedOffset: readNumberFlag("--seed-offset", 0),
  outputDirectory: process.argv.includes("--output-dir")
    ? process.argv[process.argv.indexOf("--output-dir") + 1]
    : path.resolve("reports", "amazon-backfill-dry-run"),
  stateFile: process.argv.includes("--state")
    ? process.argv[process.argv.indexOf("--state") + 1]
    : path.resolve("reports", "amazon-backfill-dry-run", "state.sqlite"),
  seedOnly: process.argv.includes("--seed-only"),
  retryProduct: process.argv.includes("--retry-product")
    ? process.argv[process.argv.indexOf("--retry-product") + 1]
    : undefined,
  reconcileReadyText: process.argv.includes("--reconcile-ready-text"),
  skipSeed: process.argv.includes("--skip-seed"),
});
const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(backendDirectory, "../..");

const connectionString = process.env.BACKFILL_DATABASE_URL;
if (!cli.skipSeed && !connectionString) throw new Error("缺少 BACKFILL_DATABASE_URL；DRY 规划器不会回退到 DATABASE_URL");
const target = connectionString ? new URL(connectionString) : null;
if (target && !(["localhost", "127.0.0.1"].includes(target.hostname) && target.port === "5440" && target.pathname === "/product_restore")) {
  throw new Error(`拒绝连接非本机 Product Restore：${target.hostname}:${target.port}${target.pathname}`);
}

interface BackfillRow {
  product_id: string;
  product_name: string;
  family_id: string | null;
  company_name: string | null;
  amazon_url: string;
  external_id: string | null;
  title_raw: string | null;
  attrs: Record<string, unknown> | null;
  product_forms: string[] | null;
  image_count: string;
  has_formula: boolean;
  has_existing_ocr_text: boolean;
  source: string | null;
  created_at: Date;
}

function textReviewReasons(row: BackfillRow, result: ProductUnifyResult) {
  return [
    ...(result.baseName ? [] : ["base_name_missing"]),
    ...(result.variantConfidence >= 70 ? [] : ["variant_confidence_below_70"]),
    ...(Object.keys(result.variant).length ? [] : ["variant_empty"]),
    ...missingAmazonProductLineModifiers(
      row.title_raw ?? row.product_name,
      result.baseName,
      result.variant.edition,
    ).map((modifier) => `base_name_missing_product_line_modifier:${modifier}`),
  ];
}

const selectionSql = `
WITH amazon_listings AS (
  SELECT DISTINCT ON (pc.id)
    pc.id AS listing_id,
    pc.product_id,
    pc.channel,
    pc.external_id,
    pc.title_raw,
    pc.attrs,
    pc.observed_formula_id,
    u.url
  FROM product_channel pc
  CROSS JOIN LATERAL (
    VALUES (1, pc.original_product_url), (2, pc.url_normalized), (3, pc.website)
  ) u(priority, url)
  WHERE u.url IS NOT NULL
    AND lower(u.url) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
  ORDER BY pc.id, u.priority
),
direct_urls AS (
  SELECT DISTINCT ON (p.id) p.id AS product_id, u.url
  FROM product p
  CROSS JOIN LATERAL (VALUES (1, p.original_product_url), (2, p.website)) u(priority, url)
  WHERE u.url IS NOT NULL
    AND lower(u.url) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
  ORDER BY p.id, u.priority
),
universe AS (
  SELECT product_id FROM amazon_listings
  UNION
  SELECT product_id FROM direct_urls
),
listing_choice AS (
  SELECT DISTINCT ON (product_id)
    product_id, url, external_id, title_raw, attrs, observed_formula_id
  FROM amazon_listings
  ORDER BY product_id, (channel = 'amazon') DESC, (external_id IS NOT NULL) DESC, listing_id
),
forms AS (
  SELECT pf.product_id, array_agg(DISTINCT f.name ORDER BY f.name) AS product_forms
  FROM product_form pf
  JOIN form f ON f.id = pf.form_id
  JOIN universe u ON u.product_id = pf.product_id
  GROUP BY pf.product_id
),
images AS (
  SELECT
    pi.product_id,
    count(*) AS image_count,
    bool_or(COALESCE(btrim(pi.supplement_facts_text_clean), '') <> ''
      OR COALESCE(btrim(pi.textract_raw_text), '') <> '') AS has_existing_ocr_text
  FROM product_image pi
  LEFT JOIN product_channel image_listing ON image_listing.id = pi.listing_id
  JOIN universe u ON u.product_id = pi.product_id
  WHERE lower(COALESCE(pi.channel, '')) = 'amazon'
    OR lower(COALESCE(image_listing.channel, '')) = 'amazon'
    OR lower(pi.image_url) LIKE 'product-images/amazon/%'
    OR lower(COALESCE(image_listing.original_product_url, '')) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
    OR lower(COALESCE(image_listing.url_normalized, '')) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
    OR lower(COALESCE(image_listing.website, '')) ~ '^(https?://)?([a-z0-9-]+\\.)*amazon\\.[a-z.]+([/:?#]|$)'
  GROUP BY pi.product_id
)
SELECT
  p.id AS product_id,
  p.name AS product_name,
  p.family_id,
  c.name AS company_name,
  COALESCE(l.url, d.url) AS amazon_url,
  l.external_id,
  l.title_raw,
  l.attrs,
  f.product_forms,
  COALESCE(i.image_count, 0)::text AS image_count,
  (p.formula_id IS NOT NULL OR l.observed_formula_id IS NOT NULL) AS has_formula,
  COALESCE(i.has_existing_ocr_text, false) AS has_existing_ocr_text,
  p.source,
  p.created_at
FROM universe u
JOIN product p ON p.id = u.product_id
LEFT JOIN company c ON c.id = p.company_id
LEFT JOIN listing_choice l ON l.product_id = p.id
LEFT JOIN direct_urls d ON d.product_id = p.id
LEFT JOIN forms f ON f.product_id = p.id
LEFT JOIN images i ON i.product_id = p.id
WHERE (p.base_name IS NULL OR p.variant_key IS NULL OR p.identity_state <> 'resolved')
ORDER BY
  CASE p.source WHEN 'sales-channel-import' THEN 0 WHEN 'kalodata' THEN 1 WHEN 'enrichment' THEN 2 ELSE 3 END,
  p.created_at,
  p.id
LIMIT $1 OFFSET $2`;

await fs.mkdir(cli.outputDirectory, { recursive: true });
const pool = connectionString ? new pg.Pool({ connectionString, max: 2 }) : null;
const codex = new CodexProcessRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: false,
});
let state: AmazonBackfillState | undefined;

try {
  state = new AmazonBackfillState(cli.stateFile);
  state.recoverInterrupted("text");
  const selected = cli.skipSeed ? { rows: [] as BackfillRow[] } : await pool!.query<BackfillRow>(selectionSql, [cli.seedLimit, cli.seedOffset]);
  for (const row of selected.rows) {
    state.seed({
      productId: row.product_id,
      source: row,
      hasFormula: row.has_formula,
      hasExistingOcrText: row.has_existing_ocr_text,
      imageCount: Number(row.image_count),
    });
  }
  if (cli.retryProduct) state.retryText(cli.retryProduct);
  if (cli.reconcileReadyText) {
    for (const item of state.listReadyTextResults()) {
      const result = item.result as ProductUnifyResult;
      if (!result?.productName || !result.variant) continue;
      const source = state.get<BackfillRow>(item.productId)?.source;
      if (!source) continue;
      const reconciled = {
        ...result,
        productName: completeProductNameWithVariant(result.productName, result.variant),
      };
      const reasons = textReviewReasons(source, reconciled);
      state.recordText(item.productId, reasons.length ? "review" : "ready", reconciled, reasons.length ? { reasons } : undefined);
    }
  }
  const seededSummary = state.summary();
  const claimed = (cli.seedOnly ? [] : state.claimText(cli.limit)) as Array<{ productId: string; source: BackfillRow }>;
  const claimedRows = claimed.map((item) => item.source);
  const sources: AmazonBackfillSource[] = claimedRows.map((row) => ({
    productId: row.product_id,
    productName: row.product_name,
    companyName: row.company_name,
    titleRaw: row.title_raw,
    attrs: row.attrs,
    productForms: row.product_forms ?? [],
    familyId: row.family_id,
  }));
  await fs.writeFile(path.join(cli.outputDirectory, "selected.json"), `${JSON.stringify(claimedRows, null, 2)}\n`);

  let call = 0;
  const outcome = await runProductUnify({
    inputs: sources.map(buildAmazonBackfillUnifyInput),
    batchSize: 20,
    concurrency: 1,
    tagPrefix: "amazon-backfill-dry",
    runModel: async ({ prompt, tag }) => {
      call += 1;
      const result = await codex.run({
        prompt,
        cwd: repositoryDirectory,
        addDirectories: [cli.outputDirectory],
        schemaPath: path.join(backendDirectory, "model-payload.schema.json"),
        outputPath: path.join(cli.outputDirectory, `${String(call).padStart(3, "0")}-${tag}.result.json`),
        eventLogPath: path.join(cli.outputDirectory, `${String(call).padStart(3, "0")}-${tag}.events.jsonl`),
        signal: AbortSignal.timeout(Number(process.env.BACKFILL_MODEL_TIMEOUT_MS ?? 1_800_000)),
      });
      if (!result || typeof result !== "object" || !("payload" in result) || typeof result.payload !== "string") {
        throw new Error(`${tag}: Codex 输出缺少 payload`);
      }
      return result.payload;
    },
  });

  const selectedById = new Map(claimedRows.map((row) => [row.product_id, row]));
  const proposals = outcome.results.map((result) => {
    const row = selectedById.get(result.clientRef)!;
    const reviewReasons = textReviewReasons(row, result);
    const proposal = {
      productId: result.clientRef,
      productNameBefore: row.product_name,
      amazonUrl: row.amazon_url,
      externalId: row.external_id,
      companyName: row.company_name,
      source: row.source,
      createdAt: row.created_at,
      evidence: {
        attrs: row.attrs,
        productForms: row.product_forms ?? [],
        imageCount: Number(row.image_count),
        hasFormula: row.has_formula,
        hasExistingOcrText: row.has_existing_ocr_text,
      },
      proposal: result,
      status: reviewReasons.length ? "needs_review" : "ready",
      reviewReasons,
    };
    state.recordText(
      result.clientRef,
      reviewReasons.length ? "review" : "ready",
      result,
      reviewReasons.length ? { reasons: reviewReasons } : undefined,
    );
    return proposal;
  });
  const returnedIds = new Set(outcome.results.map((result) => result.clientRef));
  for (const item of claimed) {
    if (returnedIds.has(item.productId)) continue;
    const reasons = outcome.problems.filter((problem) => problem.includes(item.productId));
    state.recordText(item.productId, "failed", null, {
      reasons: reasons.length ? reasons : ["product_unify_missing_result"],
    });
  }
  const report = {
    mode: "dry_run_only",
    database: target ? `${target.hostname}:${target.port}${target.pathname}` : "not_connected_skip_seed",
    generatedAt: new Date().toISOString(),
    seedOffset: cli.seedOffset,
    seedLimit: cli.seedLimit,
    limit: cli.limit,
    seeded: selected.rows.length,
    selected: claimedRows.length,
    ready: proposals.filter((item) => item.status === "ready").length,
    needsReview: proposals.filter((item) => item.status === "needs_review").length,
    problems: outcome.problems,
    stateFile: path.resolve(cli.stateFile),
    stateBeforeTextRun: seededSummary,
    stateAfterTextRun: state.summary(),
    proposals,
  };
  const reportFile = path.join(cli.outputDirectory, `text-lane-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: report.mode,
    database: report.database,
    selected: report.selected,
    ready: report.ready,
    needsReview: report.needsReview,
    problems: report.problems.length,
    output: reportFile,
    stateFile: report.stateFile,
    state: report.stateAfterTextRun,
  }, null, 2));
} finally {
  state?.close();
  await codex.close?.();
  await pool?.end();
}
