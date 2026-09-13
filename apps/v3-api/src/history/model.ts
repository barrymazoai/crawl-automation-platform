import { createHash } from "node:crypto";
import { z } from "zod";

export const ObjectSchema = z.record(z.string(), z.unknown());
export type Row = z.infer<typeof ObjectSchema>;
export const LegacyProductSchema = z.strictObject({
  codec: z.literal("legacy-product/1"), dataset: z.string().min(1).max(200),
  kind: z.enum(["product", "reference", "no-company"]), product: ObjectSchema,
  listings: z.array(z.strictObject({ row: ObjectSchema, snapshots: z.array(ObjectSchema) })),
  images: z.array(ObjectSchema), ingredients: z.array(ObjectSchema),
  formulas: z.array(z.strictObject({ row: ObjectSchema, rows: z.array(ObjectSchema) })),
  formulaObservations: z.array(ObjectSchema),
});
export type LegacyProduct = z.infer<typeof LegacyProductSchema>;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`).join(",")}}`;
}
export const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
export const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
function objectValue(v: unknown): Row {
  try { const parsed=typeof v==="string"?JSON.parse(v):v;return ObjectSchema.parse(parsed); }
  catch { return {}; }
}
export function timestamp(v: unknown): string | null {
  const s = text(v);
  // Date-only values and timestamps with no timezone cannot locate a trend point.
  if (!s || !/T|\s\d{2}:\d{2}/u.test(s) || !/(Z|[+-]\d{2}(?::?\d{2})?)$/u.test(s)) return null;
  const n = Date.parse(s); return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function decimal(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return /^-?\d+(?:\.\d+)?$/u.test(s) && Number.isFinite(Number(s)) ? s : null;
}
export type Listing = { id: string; channel: string; site: string | null; externalId: string | null;
  url: string | null; basis: "external-id" | "url" | "unresolved"; identity: Row };
export function identifyListing(row: Row, dataset: string, sourceKey: string): Listing {
  const channel = (text(row.channel) ?? "unknown").toLowerCase();
  let url: URL | null = null;
  // Legacy url_normalized omits the scheme and lowercases paths. Prefer the
  // original navigable URL; do not turn the normalization key into evidence.
  for (const candidate of [row.original_product_url,row.product_url,row.source_url,row.url_normalized]) {
    try { const u = new URL(text(candidate) ?? ""); if (["http:","https:"].includes(u.protocol) && !u.username && !u.password) { url=u;break; } }
    catch { /* retained in raw record */ }
  }
  if (url) {
    url.hash = ""; url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^(ref|ref_|tag|linkCode|linkId|th|psc)$/u.test(k)) url.searchParams.delete(k);
    url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  const host = url?.hostname ?? null;
  const belongs = channel === "amazon" ? !!host && /(^|\.)amazon\.(com|ca|co\.uk|de|fr|it|es|co\.jp|com\.au)$/u.test(host)
    : channel === "gnc" ? host === "gnc.com"
    : channel === "swanson" ? host === "swansonvitamins.com"
    : channel === "dtc" ? !!host : false;
  const external = text(row.external_id);
  const asin = channel === "amazon" && belongs ? url?.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/iu)?.[1]?.toUpperCase() : null;
  const invalidAsin = channel === "amazon" && !!external && !/^[A-Z0-9]{10}$/iu.test(external);
  const conflict = !!asin && !!external && asin !== external.toUpperCase();
  const site = belongs ? host : null;
  const externalId = invalidAsin || conflict ? null : channel === "amazon" ? (external?.toUpperCase() ?? asin ?? null) : external;
  // Unknown markets/sites and foreign URLs remain separate; never guess US from a channel tag.
  const basis = site && !conflict && externalId ? "external-id" : site && !conflict && url && url.pathname !== "/" ? "url" : "unresolved";
  const identity: Row = basis === "external-id" ? { channel, site, externalId }
    : basis === "url" ? { channel, site, url: url!.toString() }
    : { channel, dataset, sourceKey, legacyListingId: text(row.id), reason: conflict ? "external_id_url_conflict" : "no_verified_channel_anchor" };
  return { id: hash(identity), channel, site, externalId, url: belongs ? url?.toString() ?? null : null, basis, identity };
}
export type Observation = { id: string; listingId: string; kind: "metrics" | "formula";
  observedAt: string | null; record: Row };
export type ConvertedProduct = { id: string; dataset: string; sourceKey: string; bodyHash: string; raw: LegacyProduct | PageObservation | CaptureHistory | FormulaHistory;
  listings: Listing[]; observations: Observation[]; issues: string[] };

export function convertLegacyProduct(input: unknown): ConvertedProduct {
  const raw = LegacyProductSchema.parse(input), p = raw.product;
  const sourceKey = text(p.id) ?? (raw.kind === "no-company" && text(p.channel) && text(p.external_id) ? `${text(p.channel)}/${text(p.external_id)}` : null);
  if (!sourceKey) throw Error("HISTORY.SOURCE_ID_REQUIRED");
  const bodyHash = hash(raw), id = hash([raw.dataset, raw.kind, sourceKey, bodyHash]);
  const listings: Listing[] = [], observations: Observation[] = [], issues = new Set<string>();
  const byLegacyId = new Map<string, Listing>();
  const addMetrics = (listing: Listing, snapshot: Row, fallbackSource: string) => {
    const observedAt = timestamp(snapshot.captured_at);
    if (!observedAt) issues.add("HISTORY.METRIC_TIME_UNKNOWN");
    const record: Row = { source: text(snapshot.source) ?? fallbackSource,
      price: decimal(snapshot.price), currency: text(snapshot.currency), listPrice: decimal(snapshot.list_price),
      rating: decimal(snapshot.rating), reviewCount: decimal(snapshot.review_count), salesRank: decimal(snapshot.sales_rank),
      inStock: typeof snapshot.in_stock === "boolean" ? snapshot.in_stock : null,
      unitsSold: decimal(snapshot.units_sold), unitsSoldPeriod: text(snapshot.units_sold_period), extras: snapshot.extras ?? null };
    if (!observedAt) record.undatedSource = { dataset: raw.dataset, sourceKey, snapshotId: snapshot.id ?? null };
    const obs = { listingId: listing.id, kind: "metrics" as const, observedAt, record };
    observations.push({ id: hash(obs), ...obs });
  };
  for (const item of raw.listings) {
    const listing = identifyListing(item.row, raw.dataset, sourceKey); listings.push(listing);
    if (listing.basis === "unresolved") issues.add("HISTORY.LISTING_UNRESOLVED");
    if (text(item.row.id)) byLegacyId.set(String(item.row.id), listing);
    for (const snapshot of item.snapshots) addMetrics(listing, snapshot, raw.dataset);
    // Materialized latest values are a real point only with their explicit snapshot time.
    if (!item.snapshots.length && ["latest_price", "latest_rating", "latest_review_count"].some(k => item.row[k] != null))
      addMetrics(listing, { captured_at: item.row.latest_snapshot_at, source: `${raw.dataset}:latest-cache`,
        price: item.row.latest_price, currency: item.row.latest_currency, rating: item.row.latest_rating,
        review_count: item.row.latest_review_count }, `${raw.dataset}:latest-cache`);
  }
  if (raw.kind === "no-company" && listings[0]) {
    const capture=objectValue(p.raw_json),variant=objectValue(capture.variant),label=objectValue(p.facts_json),facts=objectValue(label.facts);
    addMetrics(listings[0], { captured_at:p.captured_at,source:`${raw.dataset}:capture`,price:p.price,
      currency:capture.currency??p.currency,rating:capture.rating,review_count:capture.reviewCount,
      in_stock:capture.inStock??variant.available },raw.dataset);
    if(Array.isArray(facts.rows)&&facts.rows.length){
      const observedAt=timestamp(facts.capturedAt);
      const record:Row={codec:"legacy-facts/1",label,source:text(facts.source)??raw.dataset,confidence:facts.confidence??null,
        dataset:raw.dataset,sourceKey};
      const obs={listingId:listings[0].id,kind:"formula" as const,observedAt,record};
      observations.push({id:hash(obs),...obs});
      if(!observedAt)issues.add("HISTORY.FORMULA_TIME_UNKNOWN");
    }else issues.add("HISTORY.FORMULA_ROWS_MISSING");
  }
  for (const source of raw.formulaObservations) {
    const listing = byLegacyId.get(String(source.listing_id)) ?? (source.listing_id == null && listings.length === 1 ? listings[0] : undefined);
    if (!listing) { issues.add("HISTORY.FORMULA_LISTING_UNRESOLVED"); continue; }
    const formula = raw.formulas.find(f => f.row.id === source.formula_id);
    if (!formula) { issues.add("HISTORY.FORMULA_BODY_MISSING"); continue; }
    const observedAt = timestamp(source.observed_at);
    const record: Row = { codec: "legacy-formula/1", formula, source: text(source.source) ?? raw.dataset,
      confidence: source.confidence ?? null, sourceImageId: source.source_image_id ?? null,
      originalObservation: source, dataset: raw.dataset, sourceKey };
    const obs = { listingId: listing.id, kind: "formula" as const, observedAt, record };
    observations.push({ id: hash(obs), ...obs });
    if (!observedAt) issues.add("HISTORY.FORMULA_TIME_UNKNOWN");
  }
  if (!raw.formulas.some(f => f.rows.length) && raw.kind !== "no-company") issues.add("HISTORY.FORMULA_ROWS_MISSING");
  if (raw.formulas.length && !raw.formulaObservations.length) issues.add("HISTORY.FORMULA_TIME_UNKNOWN");
  return { id, dataset: raw.dataset, sourceKey, bodyHash, raw, listings: [...new Map(listings.map(l => [l.id, l])).values()],
    observations: [...new Map(observations.map(o => [o.id, o])).values()], issues: [...issues].sort() };
}

const amount=z.string().regex(/^-?\d+(?:\.\d+)?$/u).nullable();
/** Normal capture can commit this independently of any later OCR / label outcome. */
export const PageObservationSchema=z.strictObject({codec:z.literal("page-observation/1"),
  dataset:z.string().min(1).max(200),observationId:z.string().min(1).max(200),capturedAt:z.iso.datetime(),
  listing:z.strictObject({channel:z.enum(["amazon","swanson","gnc","dtc"]),url:z.url(),externalId:z.string().min(1).nullable()}),
  metrics:z.strictObject({price:amount,currency:z.string().min(1).nullable(),listPrice:amount,rating:amount,reviewCount:amount,
    salesRank:amount,inStock:z.boolean().nullable(),unitsSold:amount,unitsSoldPeriod:z.string().nullable(),extras:ObjectSchema.nullable()}),
  evidence:z.array(z.strictObject({objectKey:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/u)})).min(1),
  capture: ObjectSchema,
});
export type PageObservation=z.infer<typeof PageObservationSchema>;
// Retained V3 captures may predate capture timestamps. Keep them, but never
// manufacture a trend date from ingestion time or a later model completion.
export const CaptureHistorySchema=PageObservationSchema.extend({codec:z.literal("v3-capture-history/1"),
  capturedAt:z.iso.datetime().nullable(),owner:ObjectSchema});
export type CaptureHistory=z.infer<typeof CaptureHistorySchema>;
export const FormulaHistorySchema=z.strictObject({codec:z.literal("v3-formula-history/1"),dataset:z.string().min(1).max(200),
  observationId:z.string().min(1),operationId:z.string().min(1),captureSourceId:z.string().regex(/^[a-f0-9]{64}$/u),
  capturedAt:z.iso.datetime().nullable(),listing:PageObservationSchema.shape.listing,collection:ObjectSchema});
export type FormulaHistory=z.infer<typeof FormulaHistorySchema>;
export function convertHistoryInput(input:unknown):ConvertedProduct {
  if((input as Row)?.codec==="v3-formula-history/1"){
    const raw=FormulaHistorySchema.parse(input),listing=identifyListing({channel:raw.listing.channel,original_product_url:raw.listing.url,external_id:raw.listing.externalId},raw.dataset,raw.observationId);
    if(listing.basis==="unresolved")throw Error("HISTORY.CAPTURE_IDENTITY_UNRESOLVED");
    const record:Row={codec:raw.codec,collection:raw.collection,captureSourceId:raw.captureSourceId,observationId:raw.observationId,source:raw.dataset};
    const obs={listingId:listing.id,kind:"formula" as const,observedAt:timestamp(raw.capturedAt),record};
    return{id:hash([raw.codec,raw.dataset,raw.operationId]),dataset:raw.dataset,sourceKey:raw.operationId,bodyHash:hash(raw),raw,
      listings:[listing],observations:[{id:hash(obs),...obs}],issues:raw.capturedAt?[]:["HISTORY.FORMULA_TIME_UNKNOWN"]};
  }
  if((input as Row)?.codec==="v3-capture-history/1"){
    const raw=CaptureHistorySchema.parse(input),listing=identifyListing({channel:raw.listing.channel,original_product_url:raw.listing.url,external_id:raw.listing.externalId},raw.dataset,raw.observationId);
    if(listing.basis==="unresolved")throw Error("HISTORY.CAPTURE_IDENTITY_UNRESOLVED");
    const obs={listingId:listing.id,kind:"metrics" as const,observedAt:timestamp(raw.capturedAt),
      record:{...raw.metrics,source:raw.dataset,observationId:raw.observationId,evidence:raw.evidence}};
    return{id:hash([raw.codec,raw.dataset,raw.observationId]),dataset:raw.dataset,sourceKey:raw.observationId,bodyHash:hash(raw),raw,
      listings:[listing],observations:[{id:hash(obs),...obs}],issues:raw.capturedAt?[]:["HISTORY.METRIC_TIME_UNKNOWN"]};
  }
  if((input as Row)?.codec!=="page-observation/1")return convertLegacyProduct(input);
  const raw=PageObservationSchema.parse(input),bodyHash=hash(raw);
  const listing=identifyListing({channel:raw.listing.channel,original_product_url:raw.listing.url,external_id:raw.listing.externalId},raw.dataset,raw.observationId);
  if(listing.basis==="unresolved")throw Error("HISTORY.CAPTURE_IDENTITY_UNRESOLVED");
  const observedAt=timestamp(raw.capturedAt)!;
  const record:Row={...raw.metrics,source:raw.dataset,observationId:raw.observationId,evidence:raw.evidence};
  const obs={listingId:listing.id,kind:"metrics" as const,observedAt,record};
  // Unlike a legacy mutable source row, a new capture identity has one immutable body.
  return {id:hash(["page-observation/1",raw.dataset,raw.observationId]),dataset:raw.dataset,sourceKey:raw.observationId,
    bodyHash,raw,listings:[listing],observations:[{id:hash(obs),...obs}],issues:[]};
}
