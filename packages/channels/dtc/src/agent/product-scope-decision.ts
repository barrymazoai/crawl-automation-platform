import { z } from "zod";
import { dtcAgentErrors } from "./errors.js";

const citation = z.strictObject({ field: z.string().min(1), quote: z.string().min(1).max(4000) });
export const ProductScopeDecisionSchema = z.strictObject({
  kind: z.enum(["single_product", "multi_product_bundle", "unresolved"]),
  reason: z.string().min(1).max(4000),
  evidence: z.array(citation).max(20),
  components: z
    .array(z.strictObject({ name: z.string().min(1).max(300), evidence: citation }))
    .max(20),
});
export type ProductScopeDecision = z.infer<typeof ProductScopeDecisionSchema>;

export function validateAnswer(answer: string, fields: Record<string, string>, answerKey: string) {
  try {
    return validateProductScope(JSON.parse(answer), fields);
  } catch (error) {
    if (dtcAgentErrors.is(error, "DTC.PRODUCT_SCOPE_UNRESOLVED")) {
      throw dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED", {
        cause: error,
        details: { ...error.details, evidenceKeys: [answerKey] },
      });
    }
    throw error;
  }
}

export function validateProductScope(raw: unknown, fields: Record<string, string>) {
  const decision = ProductScopeDecisionSchema.parse(raw);
  const citations = [...decision.evidence, ...decision.components.map((part) => part.evidence)];
  if (
    citations.some(
      (entry) => !normalizeQuote(fields[entry.field] ?? "").includes(normalizeQuote(entry.quote)),
    )
  ) {
    throw dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED", {
      details: { reason: "citation_not_in_retained_field" },
    });
  }
  if (decision.kind !== "unresolved" && !decision.evidence.length) {
    throw dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED", {
      details: { reason: "missing_citations" },
    });
  }
  if (
    decision.kind === "multi_product_bundle" &&
    new Set(decision.components.map((part) => part.name.trim().toLowerCase())).size < 2
  ) {
    throw dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED", {
      details: { reason: "missing_distinct_component_citations" },
    });
  }
  return decision;
}

function normalizeQuote(text: string) {
  return (
    text
      .normalize("NFKC")
      .replace(/[\u2018-\u201B\u2032]/gu, "'")
      .replace(/[\u201C-\u201F\u2033]/gu, '"')
      .replace(/[\u2013\u2014]/gu, "-")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
      // Owner 2026-10-25: models emit stray control characters inside quotes ("UTERUS\x06 TEA", "Blood Cleanse\x02\x00").
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}
