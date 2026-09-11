import { isDeepStrictEqual } from "node:util";
import { LabelTextCandidateSchema, LabelImageCandidateSchema, assessLabelCandidate, labelFormulaStructure } from "@crawl-automation/v3-contracts";
type Source = { kind: "text" | "image"; candidate: unknown };
/** Pure pairwise diagnostics only. No ownership, citation verification, registration or ingestion approval. */
export function compareLabelStructure(left: Source, right: Source) {
  const parse = (source: Source) => (source.kind === "text" ? LabelTextCandidateSchema : LabelImageCandidateSchema).parse(source.candidate);
  const a = parse(left), b = parse(right), checks = [assessLabelCandidate(a), assessLabelCandidate(b)];
  if (checks.some(c => c.status !== "candidate")) return { status: "unresolved" as const,
    codes: [...new Set(checks.flatMap(c => c.codes).concat("LABEL.SOURCE_NOT_COMPLETE"))] };
  const fa = labelFormulaStructure(a)!, fb = labelFormulaStructure(b)!, codes: string[] = [];
  const { servingsPerContainer: ca, ...bodyA } = fa, { servingsPerContainer: cb, ...bodyB } = fb;
  if (!isDeepStrictEqual(bodyA, bodyB)) codes.push("LABEL.FORMULA_CONFLICT");
  if (ca !== cb) codes.push("LABEL.CONTAINER_COUNT_CONFLICT");
  const other = (c: typeof a) => c.otherIngredients?.items.map(i => i.text.replace(/\s+/gu, " ").trim()) ?? null;
  if (!isDeepStrictEqual(other(a), other(b))) codes.push("LABEL.OTHER_INGREDIENTS_CONFLICT");
  return { status: codes.length ? "conflict" as const : "match" as const, codes };
}
