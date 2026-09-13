import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { CaptureHistorySchema, FormulaHistorySchema, convertHistoryInput, hash, text, timestamp, type ConvertedProduct, type Row } from "./model.js";

/** Offline material for Jakarta's two ingestion contracts. It never sends requests
 * or resolves companies. The receiver supplies the brand domain at import time. */
export function productServiceMaterial(value: ConvertedProduct, relatedCapture?: unknown) {
  const pending: string[] = [], metrics: Row[] = [], labels: Row[] = [];
  const raw = value.raw as unknown as Row;
  const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
  const captured = raw.codec === "v3-capture-history/1" ? CaptureHistorySchema.parse(raw)
    : relatedCapture ? CaptureHistorySchema.parse(relatedCapture) : undefined;
  const projection = row(captured?.capture.projection), legacy = row(projection.legacy);
  const original = row(raw.product);
  const productName = text(projection.title) ?? text(row(legacy.fields).name) ?? text(legacy.name)
    ?? text(original.name) ?? text(original.product_name) ?? text(original.title);
  const listingFields = (listing: ConvertedProduct["listings"][number]) => ({
    ...(productName ? { productName } : {}), ...(listing.url ? { productUrl: listing.url, sourceUrl: listing.url } : {}),
    ...(listing.externalId ? { externalId: listing.externalId } : {}),
    ...(listing.channel === "dtc" && listing.site ? { siteKey: listing.site } : {}),
  });
  for (const observation of value.observations.filter(o => o.kind === "metrics")) {
    const listing = value.listings.find(l => l.id === observation.listingId)!;
    if (!observation.observedAt || !productName || listing.basis === "unresolved") {
      pending.push(`metrics:${observation.id}:${!observation.observedAt ? "time-unknown" : !productName ? "title-unknown" : "identity-unresolved"}`); continue;
    }
    const r = observation.record, item: Row = { ...listingFields(listing), clientRef: observation.id, capturedAt: observation.observedAt, images: [],
      // Preserve all raw decimals, purchase conditions, evidence and unknowns even
      // where the destination's numeric field cannot represent them safely.
      extras: { historySourceId: value.id, historyObservationId: observation.id, retainedMetrics: r } };
    for (const key of ["price", "currency", "listPrice"] as const) if (r[key] !== null && r[key] !== undefined) item[key] = r[key];
    for (const key of ["rating", "reviewCount", "salesRank", "unitsSold"] as const) {
      if (r[key] === null || r[key] === undefined) continue;
      const n = Number(r[key]), valid = Number.isFinite(n) && (key === "rating" ? n >= 0 && n <= 5 : Number.isSafeInteger(n) && n >= (key === "salesRank" ? 1 : 0));
      if (valid) item[key] = n; else pending.push(`metrics:${observation.id}:${key}-retained-in-extras`);
    }
    if (typeof r.inStock === "boolean") item.inStock = r.inStock;
    if (["trailing_30d", "monthly", "lifetime", "unknown"].includes(String(r.unitsSoldPeriod))) item.unitsSoldPeriod = r.unitsSoldPeriod;
    // One immutable point per run/ref: distinct historical observations never
    // overwrite the target service's per-run clientRef ledger.
    metrics.push({ run: { runId: `history-${observation.id}`, channel: listing.channel, scope: "partial",
      startedAt: observation.observedAt, source: `crawler-history:${observation.id}`,
      ...(listing.channel === "dtc" ? { siteKey: listing.site } : {}) }, items: [item] });
  }
  if (raw.codec === "v3-formula-history/1") {
    const formula = FormulaHistorySchema.parse(raw), collection = LabelCollectedProductSchema.parse(formula.collection);
    if (!captured || hash(captured.owner) !== hash(collection.observation) || convertHistoryInput(captured).id !== formula.captureSourceId
      || hash(captured.listing) !== hash(formula.listing) || timestamp(captured.capturedAt) !== timestamp(formula.capturedAt)) throw Error("HISTORY.EXPORT_CAPTURE_IDENTITY");
    if (!formula.capturedAt || !productName) pending.push(`label:${formula.operationId}:${!formula.capturedAt ? "time-unknown" : "title-unknown"}`);
    else {
      const sourceIds = new Set<string>();
      const visit = (v: unknown) => { if (Array.isArray(v)) return v.forEach(visit); const r = row(v); if (typeof r.sourceId === "string") sourceIds.add(r.sourceId); Object.values(r).filter(v => v && typeof v === "object").forEach(visit); };
      visit(collection.formula); visit(collection.otherIngredients);
      const used = collection.provenance.filter(p => sourceIds.has(p.id));
      const exclusions = used.flatMap(p => p.candidate.exclusions.map(e => ({ reason: e.reason,
        quote: { text: e.quote.text, sourceId: p.id, citation: "evidence" in e.quote
          ? { kind: "image", evidence: e.quote.evidence } : { kind: "text", start: e.quote.start, end: e.quote.end } } })));
      const content = { codec: collection.codec, formula: collection.formula, otherIngredients: collection.otherIngredients,
        formulaComplete: used.filter(p => p.candidate.formula).every(p => p.candidate.formulaComplete),
        ingredientsComplete: used.filter(p => p.candidate.otherIngredients || p.candidate.formula?.columns.some(c => c.rows.some(r => r.kind === "blend_component"))).every(p => p.candidate.ingredientsComplete),
        exclusions, issues: used.flatMap(p => p.candidate.issues), warnings: collection.warnings };
      const draft = { schemaVersion: 1, submitter: { namespace: "crawler-v3", operationId: formula.operationId },
        observation: { ...collection.observation, capturedAt: formula.capturedAt }, channel: captured.listing.channel,
        source: `crawler-v3:${collection.observation.observationId}`, listing: listingFields(value.listings[0]!), images: [],
        label: { content, evidence: { ...(collection.evidencePolicy ? { evidencePolicy: collection.evidencePolicy } : {}),
          assembly: collection.assembly, provenance: collection.provenance.map(p => ({ id: p.id, kind: p.kind })),
          ...(collection.schemaVersion === 4 ? { packaging: collection.packaging } : {}) } } };
      labels.push({ draft, labelHash: hash(content), requiredAtImport: ["company.domain"],
        // Confidence is absent in the source collection; do not invent 100.
        confidence: "unknown" });
    }
  } else if (value.observations.some(o => o.kind === "formula") || raw.codec === "legacy-product/1" && Array.isArray(raw.formulas) && raw.formulas.length) {
    pending.push("legacy-formula:retained-with-original-schema");
  }
  return { codec: "product-service-material/1", sourceRecordId: value.id, companyResolution: "deferred",
    targets: { metrics: "product.ingestObservationBatch", labels: "product.ingestLabelObservation" }, metrics, labels, pending,
    // This complete source is the lossless exit for old formats, absent timestamps,
    // titles and company links. A pending adapter must never discard it.
    retained: { raw: value.raw, listings: value.listings, observations: value.observations, issues: value.issues } };
}
