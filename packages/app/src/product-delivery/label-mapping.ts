import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { productDeliveryErrors } from "./errors.js";
import { canonicalHash } from "../history/canonical.js";
import type { DeliveryItem, DeliveryLabel, DeliveryLabelContent } from "./wire.js";

export function deliveryLabelContent(record: LabelCollectedProduct): DeliveryLabelContent {
  const columns = record.formula?.columns ?? [];
  const supported = ["nutrient", "group_header", "blend_total", "blend_component"];
  if (
    record.formula?.drugFacts ||
    columns.some((column) =>
      column.rows.some((row) => !supported.includes(row.kind) || row.purpose),
    )
  ) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.LABEL_UNSUPPORTED");
  }
  return {
    codec: record.codec,
    formula: record.formula,
    otherIngredients: record.otherIngredients,
    formulaComplete: sectionComplete(record, "formula"),
    ingredientsComplete: sectionComplete(record, "otherIngredients"),
    warnings: record.warnings,
    exclusions: [],
    issues: [],
  };
}

function sectionComplete(record: LabelCollectedProduct, section: "formula" | "otherIngredients") {
  const part = record[section];
  if (!part) {
    return false;
  }
  const fields =
    section === "formula"
      ? (record.formula?.columns ?? []).flatMap((column) => column.rows.map((row) => row.name))
      : (record.otherIngredients?.items ?? []);
  const sources = new Set(fields.map((field) => field.sourceId));
  const key = section === "formula" ? "formulaComplete" : "ingredientsComplete";
  return (
    sources.size > 0 &&
    [...sources].every(
      (sourceId) =>
        record.provenance.find((source) => source.id === sourceId)?.candidate[key] === true,
    )
  );
}

export function deliveryLabelEvidence(record: LabelCollectedProduct) {
  return {
    assembly: record.assembly,
    ...(record.evidencePolicy ? { evidencePolicy: record.evidencePolicy } : {}),
    ...("packaging" in record && record.packaging ? { packaging: record.packaging } : {}),
    provenance: record.provenance.map((source) => ({
      id: source.id,
      kind: source.kind,
      operationId: source.record.input.operationId,
    })),
  };
}

/**
 * Owner 2026-10-16: a label that passed our checks goes out with confidence 100. Supply Smart makes a formula the
 * product's current formula only with a confidence of at least 70, and never fills one in itself.
 */
export const LABEL_CONFIDENCE = 100;

/**
 * Part of every label's operation and observation IDs. Supply Smart refuses a known ID with a different body, so the
 * same capture sent again with its confidence is a new submission there (2026-10-16).
 */
export const LABEL_SUBMISSION = "confidence-1";

/** Full label wire payload shared by DTC and marketplace delivery. No run-dependent identity. */
export function deliveryLabel(input: {
  item: DeliveryItem;
  collection: LabelCollectedProduct;
  company: DeliveryLabel["company"];
  channel: DeliveryLabel["channel"];
}): DeliveryLabel {
  const { item, collection, company, channel } = input;
  const { clientRef: _clientRef, domain: _domain, capturedAt, images, ...listing } = item;
  const { schemaVersion: _schemaVersion, ...observation } = collection.observation;
  return {
    schemaVersion: 1,
    submitter: {
      namespace: "crawler-v3",
      operationId: `label-${canonicalHash([collection.operationId, LABEL_SUBMISSION])}`,
    },
    observation: {
      ...observation,
      observationId: `${observation.observationId}-${LABEL_SUBMISSION}`,
      capturedAt,
    },
    company,
    channel,
    source: "crawler-v3:product-delivery",
    listing,
    images: images.slice(0, 50),
    label: {
      content: deliveryLabelContent(collection),
      evidence: deliveryLabelEvidence(collection),
      confidence: LABEL_CONFIDENCE,
    },
  };
}
