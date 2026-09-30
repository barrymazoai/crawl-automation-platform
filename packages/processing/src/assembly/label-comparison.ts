import { labelValidationErrors } from "../label/validation-errors.js";
import {
  LabelImageCandidateSchema,
  LabelTextCandidateSchema,
  assessLabelCandidate,
  labelAgreementFormula,
  labelAgreementIngredients,
  labelMetadataAgreement,
  formulaAgreement,
  ingredientsAgreement,
} from "@crawl-automation/v3-contracts";

type ComparedSource = { kind: "text" | "image"; candidate: unknown };

const parseCandidate = (source: ComparedSource) =>
  (source.kind === "text" ? LabelTextCandidateSchema : LabelImageCandidateSchema).parse(
    source.candidate,
  );

function splitContainerCount(candidate: ReturnType<typeof parseCandidate>) {
  const shape = labelAgreementFormula(candidate);
  const count = shape?.servingsPerContainer ?? null;
  if (shape) {
    shape.servingsPerContainer = null;
  }
  return { shape, count };
}

/**
 * Pairwise diagnostics only: whether two label answers describe the same formula, container count and other
 * ingredients. No ownership, citation checks, registration or approval.
 */
export function compareLabelStructure(left: ComparedSource, right: ComparedSource) {
  const first = parseCandidate(left);
  const second = parseCandidate(right);
  const checks = [assessLabelCandidate(first), assessLabelCandidate(second)];
  if (checks.some((check) => check.status !== "candidate")) {
    const codes = [
      ...new Set(
        checks
          .flatMap((check) => check.codes)
          .concat(labelValidationErrors.code("LABEL.SOURCE_NOT_COMPLETE")),
      ),
    ];
    return { status: "unresolved" as const, codes };
  }
  const firstFormula = splitContainerCount(first);
  const secondFormula = splitContainerCount(second);
  const codes: string[] = [];
  if (formulaAgreement(firstFormula.shape, secondFormula.shape) === "conflict") {
    codes.push(labelValidationErrors.code("LABEL.FORMULA_CONFLICT"));
  }
  if (labelMetadataAgreement(firstFormula.count, secondFormula.count) === "conflict") {
    codes.push(labelValidationErrors.code("LABEL.CONTAINER_COUNT_CONFLICT"));
  }
  if (
    ingredientsAgreement(labelAgreementIngredients(first), labelAgreementIngredients(second)) ===
    "conflict"
  ) {
    codes.push(labelValidationErrors.code("LABEL.OTHER_INGREDIENTS_CONFLICT"));
  }
  return { status: codes.length ? ("conflict" as const) : ("match" as const), codes };
}
