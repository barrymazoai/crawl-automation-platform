import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { productDeliveryErrors } from "./errors.js";
import type { DeliveryLabelContent } from "./wire.js";

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
