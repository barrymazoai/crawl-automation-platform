import type { LabelCandidate } from "./label-extraction.js";
import { hasConfirmedNoOtherIngredients } from "./label-ingredient-declaration.js";
import { sameServingSize } from "./label-rules/serving-size.js";
import {
  formulaAgreement,
  ingredientsAgreement,
  ingredientListRelation,
  ingredientComparisonSize,
  isFullIngredientsHeading,
  labelAgreementFormula,
  labelAgreementIngredients,
  pageIngredientsIncludeActives,
  type LabelAgreement,
} from "./label-agreement.js";

type Source = { id: string; kind: "image" | "text"; candidate: LabelCandidate };
interface CollectedAgreement {
  schemaVersion: number;
  comparisonPolicy?: "label-typography/1" | "label-typography/2" | undefined;
  formula: { columns: { rows: { name: { sourceId: string } }[] }[] } | null;
  otherIngredients: { heading: { sourceId: string } } | null;
  packaging?: { servingSize: { value: string | null } } | undefined;
  warnings: { id: string; code: string }[];
}

function formulaShape(source: Source | undefined, record: CollectedAgreement) {
  const shape = source ? labelAgreementFormula(source.candidate, record.comparisonPolicy) : null;
  if (shape && record.packaging) {
    shape.servingsPerContainer = null;
  }
  return shape;
}

const otherShape = (source: Source | undefined) =>
  source ? labelAgreementIngredients(source.candidate) : null;

function acceptsAgreement(
  record: CollectedAgreement,
  source: Source,
  result: { agreement: LabelAgreement; secondaryCode: string },
): boolean {
  if (result.agreement === "exact") {
    return true;
  }
  if (result.agreement === "conflict" && source.kind !== "text") {
    return false;
  }
  const code =
    result.agreement === "wording" ? "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS" : result.secondaryCode;
  return record.warnings.some((warning) => warning.id === source.id && warning.code === code);
}

function packagingAgrees(record: CollectedAgreement, source: Source): boolean {
  const servingSize = record.packaging?.servingSize.value;
  const shape = formulaShape(source, record);
  if (!record.packaging || !servingSize || !shape) {
    return true;
  }
  return (
    // Same acceptance as assembly (mergeSelection): a Drug Facts label without a serving size adds no conflict.
    (Boolean(shape.drugFacts) && !shape.servingSize) ||
    (shape.servingSize !== null && sameServingSize(shape.servingSize, servingSize)) ||
    record.warnings.some(
      (warning) => warning.id === source.id && warning.code === "PACKAGING.SERVING_SIZE_CONFLICT",
    )
  );
}

/** Recheck each image/text against the actual selected source, retaining every required warning. */
export function collectedSourcesAgree(record: CollectedAgreement, accepted: Source[]): boolean {
  const images = accepted.filter((source) => source.kind === "image");
  if (images.some(source => hasConfirmedNoOtherIngredients(source.candidate)) &&
    accepted.some(source => source.candidate.otherIngredients)) return false;
  const formulaId = record.formula?.columns[0]?.rows[0]?.name.sourceId;
  const otherId = record.otherIngredients?.heading.sourceId;
  const formula = formulaShape(
    images.find((source) => source.id === formulaId),
    record,
  );
  const other = otherShape(images.find((source) => source.id === otherId));
  const formulaNames = formula?.columns.flatMap(column => column.rows.map(row => row.name).filter(
    (name): name is string => name !== null,
  )) ?? [];
  return accepted.every((source) => {
    const formulaResult = source.candidate.formula
      ? formulaAgreement(formula, formulaShape(source, record))
      : "exact";
    const otherResult = source.candidate.otherIngredients
      ? ingredientsAgreement(other, otherShape(source), record.comparisonPolicy)
      : "exact";
    const sourceOther = otherShape(source);
    const pageHasActives = source.kind === "text" &&
      pageIngredientsIncludeActives(other, sourceOther, formulaNames);
    const relation = source.candidate.otherIngredients
      ? ingredientListRelation(other, sourceOther) : "exact";
    const unexplainedFullPage = source.kind === "text" &&
      isFullIngredientsHeading(source.candidate.otherIngredients?.heading.text) &&
      !pageHasActives && (relation === "conflict" ||
        relation === "subset" && other && sourceOther &&
        ingredientComparisonSize(other) < ingredientComparisonSize(sourceOther));
    if (unexplainedFullPage) return false;
    const shorterId = relation === "subset" && other && sourceOther &&
      ingredientComparisonSize(other) < ingredientComparisonSize(sourceOther) ? otherId : source.id;
    const ingredientWarning = pageHasActives
      ? record.warnings.some(warning => warning.id === source.id && warning.code ===
          "LABEL_PRODUCT.INGREDIENTS_PAGE_INCLUDES_ACTIVES")
      : relation === "subset" || relation === "reordered"
      ? record.warnings.some(warning => warning.id === shorterId && warning.code ===
          (relation === "subset" ? "LABEL_PRODUCT.INGREDIENTS_SUBSET" : "LABEL_PRODUCT.INGREDIENTS_REORDERED"))
      : null;
    return (
      acceptsAgreement(record, source, {
        agreement: formulaResult,
        secondaryCode: "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT",
      }) &&
      (ingredientWarning ?? acceptsAgreement(record, source, {
        agreement: otherResult,
        secondaryCode: "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
      })) &&
      packagingAgrees(record, source)
    );
  });
}
