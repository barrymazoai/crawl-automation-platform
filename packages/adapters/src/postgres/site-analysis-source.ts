import type { SiteAnalysisApplyResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import type { AnalyzedBrand } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { insertAnalyzedSettings, replaceAnalyzedSettings } from "./site-analysis-settings.js";

type SourceInput = {
  brand: AnalyzedBrand;
  analysisId: string;
  singleBrand: boolean;
  replaceSettings: boolean;
};

/** A correction only looks up existing brand and source identities. */
export async function applyAnalyzedSource(
  tx: Queryable,
  input: SourceInput,
  result: SiteAnalysisApplyResult,
) {
  const { brand, replaceSettings } = input;
  const brandId = replaceSettings
    ? await findBrand(tx, brand.name)
    : await matchBrand(tx, brand.name);
  if (!brandId) {
    result.skipped.push({ name: brand.name, reason: "No existing brand to correct" });
    return;
  }
  const existing = await tx.query<Record<string, unknown>>(
    "SELECT id,channel FROM brand_source WHERE brand_id=$1 AND region='US' AND url=$2",
    [brandId, brand.catalogUrl],
  );
  if (existing[0]) {
    await matchSource(tx, { ...input, row: existing[0], brandId }, result);
    return;
  }
  if (replaceSettings) {
    result.skipped.push({ name: brand.name, reason: "No existing DTC source to correct" });
    return;
  }
  const sourceId = await insertSource(tx, { ...input, brandId });
  result.created.push({ name: brand.name, brandId, sourceId });
}

async function insertSource(tx: Queryable, input: SourceInput & { brandId: string }) {
  const { brand, brandId, analysisId, singleBrand } = input;
  const sources = await tx.query<Record<string, unknown>>(
    `INSERT INTO brand_source (brand_id,channel,region,url,enabled)
    VALUES ($1,'dtc','US',$2,true) RETURNING id`,
    [brandId, brand.catalogUrl],
  );
  const sourceId = z.uuid().parse(sources[0]?.["id"]);
  await insertAnalyzedSettings(tx, { sourceId, analysisId, brand, singleBrand });
  return sourceId;
}

async function matchBrand(tx: Queryable, name: string): Promise<string> {
  await tx.query<Record<string, unknown>>(
    "INSERT INTO brand (name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING",
    [name],
  );
  const rows = await tx.query<Record<string, unknown>>(
    "SELECT id FROM brand WHERE lower(name)=lower($1)",
    [name],
  );
  return z.uuid().parse(rows[0]?.["id"]);
}

async function findBrand(tx: Queryable, name: string): Promise<string | null> {
  const rows = await tx.query<Record<string, unknown>>(
    "SELECT id FROM brand WHERE lower(name)=lower($1)",
    [name],
  );
  return rows[0] ? z.uuid().parse(rows[0]["id"]) : null;
}

async function matchSource(
  tx: Queryable,
  input: SourceInput & { row: Record<string, unknown>; brandId: string },
  result: SiteAnalysisApplyResult,
) {
  const { row, brand, brandId, analysisId, singleBrand, replaceSettings } = input;
  if (row["channel"] !== "dtc") {
    result.skipped.push({ name: brand.name, reason: "Existing source belongs to another channel" });
    return;
  }
  const sourceId = z.uuid().parse(row["id"]);
  if (replaceSettings) {
    const correction = await replaceAnalyzedSettings(tx, {
      sourceId,
      analysisId,
      brand,
      singleBrand,
    });
    if (correction) {
      result.corrected?.push({ name: brand.name, brandId, sourceId, ...correction });
    }
    result.matched.push({ name: brand.name, brandId, sourceId });
    return;
  }
  if (!(await insertAnalyzedSettings(tx, { sourceId, analysisId, brand, singleBrand }))) {
    result.skipped.push({
      name: brand.name,
      reason: "Existing source settings conflict; preserved unchanged",
    });
    return;
  }
  result.matched.push({ name: brand.name, brandId, sourceId });
}
