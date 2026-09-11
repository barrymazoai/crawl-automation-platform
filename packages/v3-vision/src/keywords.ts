import { createHash } from "node:crypto";
import { z } from "zod";
import { DefaultKeywordPolicy, KeywordPolicySchema, KeywordResultSchema, ObservationSchema, ImageEvidenceSchema,
  ExecutionIdSchema, type KeywordResult } from "@crawl-automation/v3-contracts";
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const input = z.strictObject({ observation: ObservationSchema, image: ImageEvidenceSchema,
  ocrOperationId: ExecutionIdSchema, text: z.string().max(2000000) });

/** Pure successful-OCR classifier. Errors/pending work must never be converted to empty text by callers. */
export function screenKeywords(raw: unknown, rawPolicy: unknown = DefaultKeywordPolicy): KeywordResult {
  const i = input.parse(raw), policy = KeywordPolicySchema.parse(rawPolicy);
  const normalized = i.text.toLowerCase().replace(/\s+/gu, " ").trim();
  const matchedKeywords = policy.keywords.filter(term =>
    new RegExp(`(?:^|[^a-z0-9_])${term.toLowerCase()}(?=$|[^a-z0-9_])`, "u").test(normalized));
  return KeywordResultSchema.parse({ schemaVersion: 1, observation: i.observation, image: i.image,
    ocrOperationId: i.ocrOperationId, ocrTextSha256: digest(i.text), policy, policyFingerprint: digest(JSON.stringify(policy)),
    status: matchedKeywords.length ? "matched" : "not_matched", matchedKeywords });
}

/** Recompute the decision from verified evidence instead of trusting a caller-supplied matched flag. */
export function verifySelection(raw: unknown, text: string): KeywordResult {
  const s = KeywordResultSchema.parse(raw);
  const expected = screenKeywords({ observation: s.observation, image: s.image, ocrOperationId: s.ocrOperationId, text }, s.policy);
  if (JSON.stringify(s) !== JSON.stringify(expected)) throw Error("SCREEN.EVIDENCE_MISMATCH");
  return expected;
}
