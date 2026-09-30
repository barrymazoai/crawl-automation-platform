import { labelValidationErrors } from "../label/validation-errors.js";
import { isDeepStrictEqual } from "node:util";
import {
  LabelImageCandidateSchema,
  LabelTextCandidateSchema,
  assessLabelCandidate,
  labelFormulaStructure,
} from "@crawl-automation/v3-contracts";
import { words } from "./merge-state.js";

type ComparedSource = { kind: "text" | "image"; candidate: unknown };

const parseCandidate = (source: ComparedSource) =>
  (source.kind === "text" ? LabelTextCandidateSchema : LabelImageCandidateSchema).parse(
    source.candidate,
  );

const otherNames = (candidate: ReturnType<typeof parseCandidate>) =>
  candidate.otherIngredients?.items.map((item) => words(item.text)) ?? null;

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
  const firstFormula = labelFormulaStructure(first);
  const secondFormula = labelFormulaStructure(second);
  const codes: string[] = [];
  const { servingsPerContainer: firstCount, ...firstBody } = firstFormula ?? {};
  const { servingsPerContainer: secondCount, ...secondBody } = secondFormula ?? {};
  if (!isDeepStrictEqual(firstBody, secondBody)) {
    codes.push(labelValidationErrors.code("LABEL.FORMULA_CONFLICT"));
  }
  if (firstCount !== secondCount) {
    codes.push(labelValidationErrors.code("LABEL.CONTAINER_COUNT_CONFLICT"));
  }
  if (!isDeepStrictEqual(otherNames(first), otherNames(second))) {
    codes.push(labelValidationErrors.code("LABEL.OTHER_INGREDIENTS_CONFLICT"));
  }
  return { status: codes.length ? ("conflict" as const) : ("match" as const), codes };
}
