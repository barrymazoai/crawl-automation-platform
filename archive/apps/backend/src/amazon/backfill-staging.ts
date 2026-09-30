import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import pg from "pg";
import { z } from "zod";
import type { AmazonFormulaProposal } from "./backfill-formula.js";

const sourceSchema = z.object({
  product_id: z.string().uuid(),
  product_name: z.string(),
  company_name: z.string().nullable(),
  amazon_url: z.string().url(),
  external_id: z.string().nullable(),
  title_raw: z.string().nullable(),
  attrs: z.record(z.string(), z.unknown()).nullable(),
  product_forms: z.array(z.string()).nullable(),
  created_at: z.coerce.date(),
});
const textSchema = z.object({
  clientRef: z.string(), productName: z.string().min(1), baseName: z.string().nullable(),
  variant: z.record(z.string(), z.unknown()), variantConfidence: z.number().int(),
  variantSource: z.enum(["ai_extract", "channel_attrs"]), attrsRaw: z.record(z.string(), z.unknown()),
});
const imageEvidenceSchema = z.object({
  factsCandidates: z.array(z.object({
    imageUrl: z.string().url(), imageIndex: z.number().int(),
    response: z.object({ text: z.string().optional() }).passthrough(),
  })).default([]),
});

export interface AmazonStagingTask {
  productId: string;
  source: unknown;
  textResult: unknown;
  imageResult: unknown;
  formulaResult: unknown;
  formulaSource: string | null;
  review: unknown;
  joinStatus: "ready" | "review";
}

type Target = {
  productId: string;
  listingId: string | null;
  companyId: string | null;
  companyName: string | null;
  companyWebsite: string | null;
  formulaId: string | null;
};

type CompanyAnchor = {
  companyId: string;
  companyName: string;
  companyWebsite: string;
};

const ASIN_RE = /^[A-Z0-9]{10}$/;

export function extractAmazonAsin(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const pathAsin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1];
    const queryAsin = url.searchParams.get("asin") ?? url.searchParams.get("ASIN") ?? url.searchParams.get("pd_rd_i");
    const candidate = (pathAsin ?? queryAsin ?? "").trim().toUpperCase();
    return ASIN_RE.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function effectiveAmazonExternalId(externalId: string | null, amazonUrl: string) {
  const supplied = externalId?.trim();
  return supplied || extractAmazonAsin(amazonUrl);
}

const ingestOutputSchema = z.object({
  results: z.array(z.object({
    clientRef: z.string(),
    status: z.enum(["ok", "failed"]),
    productId: z.string().nullable(),
    listingId: z.string().nullable(),
    matchedBy: z.string().nullable(),
    identity: z.object({ state: z.string(), variantKey: z.string().nullable().optional() }).passthrough().nullable(),
    facts: z.object({ factsHash: z.string() }).passthrough().nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }).passthrough()),
}).passthrough();

const verifyOutputSchema = z.object({
  found: z.boolean(),
  verified: z.number(),
  expected: z.number(),
  problems: z.array(z.string()),
  items: z.array(z.object({
    clientRef: z.string(),
    problems: z.array(z.string()),
    mismatches: z.array(z.object({ field: z.string() }).passthrough()),
  }).passthrough()),
}).passthrough();

function databaseGuard(databaseUrl: string) {
  const target = new URL(databaseUrl);
  if (!( ["localhost", "127.0.0.1"].includes(target.hostname) && target.port === "5432" && target.pathname === "/product_staging")) {
    throw new Error(`拒绝写入非 Staging 数据库：${target.hostname}:${target.port}${target.pathname}`);
  }
}

function productServerGuard(productServerUrl: string) {
  const target = new URL(productServerUrl);
  if (!(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname) && target.port === "3111")) {
    throw new Error(`拒绝调用非 Staging Product Server：${target.protocol}//${target.hostname}:${target.port}`);
  }
}

function reviewReasons(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([lane, detail]) => {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [`${lane}:review`];
    const reasons = (detail as { reasons?: unknown }).reasons;
    return Array.isArray(reasons) ? reasons.map((reason) => `${lane}:${String(reason)}`) : [`${lane}:review`];
  });
}

function capturedAt(date: Date) {
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizeDomain(value: string) {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.trim().toLowerCase().replace(/^www\./, "").split("/")[0]!;
  }
}

export function toSubmitFactsRows(rows: AmazonFormulaProposal["rows"]) {
  return rows.map((row) => {
    const value = row as typeof row & { rawText?: string; parentIndex?: number | null; taxonomy?: { substance?: string | null } | null };
    const rawText = value.rawText?.trim() ?? "";
    const name = value.taxonomy?.substance?.trim()
      || rawText.replace(/\s+\d[\d,.]*\s*(?:mcg|µg|ug|mg|g|kg|iu|cfu|ml|%)\b.*$/i, "").replace(/\s+(?:\*\*|†|‡)+\s*$/g, "").trim();
    if (!name) throw new Error(`Formula position ${row.position} 缺少可用成分名`);
    return {
      name,
      amountValue: row.amountValue ?? null,
      amountUnit: row.amountUnit ?? null,
      dvPercent: row.dvPercent ?? null,
      position: row.position,
      isActive: row.isActive,
      parentPosition: value.parentIndex ?? null,
    };
  });
}

export class AmazonBackfillStagingWriter {
  private readonly pool: pg.Pool;
  private readonly baseUrl: string;
  private runDatabaseId: string | null = null;

  constructor(private readonly options: {
    databaseUrl: string;
    productServerUrl: string;
    token?: string;
    apiKey?: string;
    runId: string;
  }) {
    databaseGuard(options.databaseUrl);
    productServerGuard(options.productServerUrl);
    this.pool = new pg.Pool({ connectionString: options.databaseUrl, max: 6 });
    this.baseUrl = options.productServerUrl.replace(/\/+$/, "");
  }

  private async ensureRun() {
    if (this.runDatabaseId) return this.runDatabaseId;
    const result = await this.pool.query<{ id: string }>(
      `insert into crawl_run(run_id,channel,scope,source,started_at,status)
       values($1,'amazon','partial','crawl-automation:amazon-backfill',now(),'open')
       on conflict(run_id) do update set updated_at=now() returning id`,
      [this.options.runId],
    );
    this.runDatabaseId = result.rows[0]!.id;
    return this.runDatabaseId;
  }

  private async resolveTarget(sourceProductId: string, externalId: string | null): Promise<Target | null> {
    const result = await this.pool.query<Target & { exact: boolean }>(
      `select p.id "productId",pc.id "listingId",p.company_id "companyId",c.name "companyName",
         coalesce(c.canonical_website,c.website) "companyWebsite",p.formula_id "formulaId",(p.id=$1::uuid) exact
       from product p
       left join company c on c.id=p.company_id
       left join lateral (
         select id from product_channel where product_id=p.id and lower(channel)='amazon'
           and ($2::text is null or external_id=$2) order by (external_id=$2) desc,created_at,id limit 1
       ) pc on true
       where p.id=$1::uuid or ($2::text is not null and exists(
         select 1 from product_channel anchor where anchor.product_id=p.id and lower(anchor.channel)='amazon' and anchor.external_id=$2
       ))
       order by exact desc,p.created_at,p.id limit 2`,
      [sourceProductId, externalId],
    );
    if (result.rows.length !== 1) return null;
    return result.rows[0]!;
  }

  private async resolveCompanyAnchor(companyName: string | null): Promise<CompanyAnchor | null> {
    const normalized = companyName?.trim();
    if (!normalized) return null;
    const result = await this.pool.query<CompanyAnchor>(
      `select id "companyId",name "companyName",coalesce(canonical_website,website) "companyWebsite"
       from company where lower(trim(name))=lower(trim($1))
         and coalesce(canonical_website,website) is not null
       order by created_at,id limit 2`,
      [normalized],
    );
    return result.rows.length === 1 ? result.rows[0]! : null;
  }

  private async rpc(name: "ingestObservationBatch" | "verifyObservationBatch", input: unknown) {
    const response = await fetch(`${this.baseUrl}/rpc/product/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        ...(this.options.apiKey ? { "x-api-key": this.options.apiKey } : {}),
      },
      body: JSON.stringify({ json: input }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await response.json().catch(() => null) as { json?: unknown } | null;
    if (!response.ok || !body || !("json" in body)) {
      throw new Error(`Product Server ${name} HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1200)}`);
    }
    return body.json;
  }

  private async upsertReview(target: Target | null, kind: string, reasons: string[], evidence: unknown, variantKey: string | null = null, matchedProductId: string | null = null) {
    const dedupeKey = createHash("sha1").update([kind, target?.productId ?? "", matchedProductId ?? "", variantKey ?? "", ...reasons].join("|")).digest("hex");
    await this.pool.query(
      `insert into product_identity_review(kind,candidate_product_id,matched_product_id,listing_id,base_name_key,variant_key,reasons,evidence,confidence,dedupe_key)
       values($1,$2,$3,$4,null,$5,$6::jsonb,$7::jsonb,null,$8)
       on conflict(dedupe_key) where status='open' do update set hits=product_identity_review.hits+1,last_seen_at=now(),updated_at=now(),evidence=excluded.evidence`,
      [kind, target?.productId ?? null, matchedProductId, target?.listingId ?? null, variantKey, JSON.stringify(reasons.map((code) => ({ code }))), JSON.stringify(evidence), dedupeKey],
    );
  }

  private async upsertRunItem(input: { sourceProductId: string; target: Target | null; status: "ok" | "needs_review" | "failed"; identityState?: string; variantKey?: string | null; reasons?: string[]; review?: unknown; factsHash?: string | null; error?: unknown }) {
    const runId = await this.ensureRun();
    await this.pool.query(
      `insert into crawl_run_item(crawl_run_id,client_ref,status,product_id,listing_id,identity_state,variant_key,reasons,review,facts_hash,error)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)
       on conflict(crawl_run_id,client_ref) do update set status=excluded.status,product_id=excluded.product_id,listing_id=excluded.listing_id,
         identity_state=excluded.identity_state,variant_key=excluded.variant_key,reasons=excluded.reasons,review=excluded.review,
         facts_hash=excluded.facts_hash,error=excluded.error,updated_at=now()`,
      [runId, input.sourceProductId, input.status, input.target?.productId ?? null, input.target?.listingId ?? null,
        input.identityState ?? null, input.variantKey ?? null, JSON.stringify(input.reasons ?? []), JSON.stringify(input.review ?? null),
        input.factsHash ?? null, JSON.stringify(input.error ?? null)],
    );
    await this.pool.query(
      `update crawl_run set items_received=(select count(*) from crawl_run_item where crawl_run_id=$1),
        items_ok=(select count(*) from crawl_run_item where crawl_run_id=$1 and status='ok'),
        items_failed=(select count(*) from crawl_run_item where crawl_run_id=$1 and status='failed'),
        items_needs_review=(select count(*) from crawl_run_item where crawl_run_id=$1 and status='needs_review'),updated_at=now() where id=$1`,
      [runId],
    );
  }

  private async readImageEvidence(imageResult: unknown) {
    if (!imageResult || typeof imageResult !== "object" || Array.isArray(imageResult)) return null;
    const evidenceFile = (imageResult as { evidenceFile?: unknown }).evidenceFile;
    if (typeof evidenceFile !== "string") return null;
    return imageEvidenceSchema.parse(JSON.parse(await fs.readFile(evidenceFile, "utf8")));
  }

  private async writeImageEvidence(target: Target, evidence: z.infer<typeof imageEvidenceSchema> | null) {
    if (!evidence) return 0;
    let written = 0;
    for (const candidate of evidence.factsCandidates) {
      const text = candidate.response.text?.trim();
      if (!text) continue;
      const image = await this.pool.query<{ id: string }>(
        `update product_image set supplement_facts_text_clean=$3,is_supplement_facts=true,textract_raw_text=$3,facts_json=$4::json,updated_at=now()
         where product_id=$1 and image_url=$2 returning id`,
        [target.productId, candidate.imageUrl, text, JSON.stringify(candidate.response)],
      );
      if (!image.rows[0]) {
        await this.pool.query(
          `insert into product_image(product_id,listing_id,channel,image_url,supplement_facts_text_clean,is_supplement_facts,textract_raw_text,facts_json)
           values($1,$2,'amazon',$3,$4,true,$4,$5::json)`,
          [target.productId, target.listingId, candidate.imageUrl, text, JSON.stringify(candidate.response)],
        );
      }
      written += 1;
    }
    return written;
  }

  async write(task: AmazonStagingTask) {
    const source = sourceSchema.parse(task.source);
    const externalId = effectiveAmazonExternalId(source.external_id, source.amazon_url);
    const target = await this.resolveTarget(task.productId, externalId);
    if (task.joinStatus === "review") {
      const reasons = reviewReasons(task.review);
      await this.upsertReview(target, "amazon_backfill_lane_review", reasons.length ? reasons : ["backfill_review"], { source, review: task.review });
      await this.upsertRunItem({ sourceProductId: task.productId, target, status: "needs_review", reasons, review: task.review });
      return { status: "review" as const, targetProductId: target?.productId ?? null, reasons };
    }
    if (!target && !externalId) {
      const reasons = ["staging_amazon_asin_missing"];
      await this.upsertReview(null, "amazon_backfill_asin_missing", reasons, { source });
      await this.upsertRunItem({ sourceProductId: task.productId, target: null, status: "needs_review", reasons, review: { source } });
      return { status: "review" as const, targetProductId: null, reasons };
    }
    const company = target
      ? { companyId: target.companyId, companyName: target.companyName, companyWebsite: target.companyWebsite }
      : await this.resolveCompanyAnchor(source.company_name);
    if (!target && !company) {
      const reasons = ["staging_company_not_found_or_ambiguous"];
      await this.upsertReview(null, "amazon_backfill_company_missing", reasons, { source, externalId });
      await this.upsertRunItem({ sourceProductId: task.productId, target: null, status: "needs_review", reasons, review: { source, externalId } });
      return { status: "review" as const, targetProductId: null, reasons };
    }
    const text = textSchema.parse(task.textResult);
    if (!company?.companyWebsite) {
      const reasons = ["staging_company_domain_missing"];
      await this.upsertReview(target, "amazon_backfill_company_domain_missing", reasons, { source, target });
      await this.upsertRunItem({ sourceProductId: task.productId, target, status: "needs_review", reasons });
      return { status: "review" as const, targetProductId: target?.productId ?? null, reasons };
    }
    const evidence = await this.readImageEvidence(task.imageResult);
    const captured = capturedAt(source.created_at);
    const formula = task.formulaResult as AmazonFormulaProposal | null;
    const readyFormula = !target?.formulaId && formula?.status === "ready" && formula.rows.length > 0 ? formula : null;
    const factsImage = evidence?.factsCandidates[0];
    const images = factsImage ? [{ clientRef: "facts-001", url: factsImage.imageUrl, role: "facts" }] : [];
    const clientRef = task.productId;
    const domain = normalizeDomain(company.companyWebsite);
    const item = {
      clientRef,
      domain,
      productName: text.productName,
      productUrl: source.amazon_url,
      ...(source.title_raw ? { titleRaw: source.title_raw } : {}),
      ...(externalId ? { externalId } : {}),
      sourceUrl: source.amazon_url,
      capturedAt: captured,
      ...(typeof text.variant.form === "string" ? { productForm: text.variant.form } : {}),
      ...(text.baseName ? { baseName: text.baseName } : {}),
      variant: text.variant,
      variantConfidence: text.variantConfidence,
      variantSource: text.variantSource,
      attrsRaw: text.attrsRaw,
      images,
      ...(readyFormula ? { facts: {
        ...(factsImage ? { sourceImageRef: "facts-001" } : {}),
        capturedAt: captured,
        source: "crawl-automation:amazon-backfill:label_ocr",
        confidence: readyFormula.confidence ?? 70,
        servingSize: readyFormula.servingSize,
        servingUnit: readyFormula.servingUnit,
        servingsPerContainer: readyFormula.servingsPerContainer,
        rows: toSubmitFactsRows(readyFormula.rows),
      } } : {}),
    };
    const ingest = ingestOutputSchema.parse(await this.rpc("ingestObservationBatch", {
      run: { runId: this.options.runId, channel: "amazon", scope: "partial", companyDomain: domain,
        startedAt: captured, source: `crawl-automation:${this.options.runId}` },
      items: [item],
    }));
    const result = ingest.results.find((candidate) => candidate.clientRef === clientRef);
    if (!result || result.status === "failed") {
      throw new Error(`Product Server ingest failed: ${result?.error?.code ?? "missing_result"}: ${result?.error?.message ?? "没有回传结果"}`);
    }
    if (!result.productId) throw new Error("Product Server ingest 没有返回 productId");
    if (target && result.productId !== target.productId) {
      throw new Error(`Product Server 与 Product Staging 不同源：expected=${target.productId}, actual=${result.productId ?? "null"}`);
    }
    const ingestedTarget: Target = target ?? {
      productId: result.productId,
      listingId: result.listingId,
      companyId: company.companyId,
      companyName: company.companyName,
      companyWebsite: company.companyWebsite,
      formulaId: null,
    };
    const ocrImagesWritten = await this.writeImageEvidence(ingestedTarget, evidence);
    const factsHash = result.facts?.factsHash ?? null;
    const verify = verifyOutputSchema.parse(await this.rpc("verifyObservationBatch", {
      runId: this.options.runId,
      clientRefs: [clientRef],
      expect: [{ clientRef, ...(factsHash ? { factsHash } : {}) }],
    }));
    const itemVerify = verify.items.find((candidate) => candidate.clientRef === clientRef);
    const verifyProblems = [
      ...verify.problems.filter((problem) => problem !== "run_not_completed"),
      ...(!verify.found ? ["run_not_found"] : []),
      ...(!itemVerify ? ["verify_item_missing"] : itemVerify.problems),
      ...(itemVerify?.mismatches.map((mismatch) => `readback_mismatch:${mismatch.field}`) ?? []),
    ];
    const readback = (await this.pool.query<{ identityState: string; variantKey: string | null; formulaId: string | null }>(
      `select identity_state "identityState",variant_key "variantKey",formula_id "formulaId" from product where id=$1`,
      [result.productId],
    )).rows[0];
    if (!readback) throw new Error(`Product Staging 回读产品不存在：${result.productId}`);
    const identityState = readback.identityState;
    const variantKey = readback.variantKey;
    if (readyFormula && !readback.formulaId) verifyProblems.push("facts_not_bound_to_product");
    if (verifyProblems.length > 0 || ["needs_review", "variant_unresolved"].includes(identityState)) {
      const reasons = [...new Set([...verifyProblems, ...(identityState === "resolved" ? [] : [`identity_${identityState}`])])];
      await this.upsertReview(ingestedTarget, "amazon_backfill_ingest_review", reasons, { source, result, verify }, variantKey, result.productId);
      return { status: "review" as const, targetProductId: result.productId, listingId: result.listingId,
        identityState, variantKey, factsHash, ocrImagesWritten, reasons };
    }
    return { status: "ready" as const, targetProductId: result.productId, listingId: result.listingId,
      identityState, variantKey, factsHash, ocrImagesWritten };
  }

  async close() { await this.pool.end(); }
}
