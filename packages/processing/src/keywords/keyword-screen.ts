import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  DefaultKeywordPolicy,
  ExecutionIdSchema,
  ImageEvidenceSchema,
  KeywordPolicySchema,
  KeywordResultSchema,
  ObservationSchema,
  type KeywordResult,
} from "@crawl-automation/v3-contracts";
import { hashString } from "../results/result-record.js";
import { keywordFailure } from "./keyword-errors.js";

const ScreenInputSchema = z.strictObject({
  observation: ObservationSchema,
  image: ImageEvidenceSchema,
  ocrOperationId: ExecutionIdSchema,
  text: z.string().max(2_000_000),
});

/** Whether a policy keyword appears in the text as whole words, ignoring case and spacing. */
function matches(normalized: string, term: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9_])${term.toLowerCase()}(?=$|[^a-z0-9_])`, "u");
  return pattern.test(normalized);
}

/**
 * Screens successful OCR text for label keywords. Only a registered OCR text may be screened: a failed or pending OCR
 * is never turned into empty text by a caller.
 */
export function screenKeywords(
  raw: unknown,
  rawPolicy: unknown = DefaultKeywordPolicy,
): KeywordResult {
  const input = ScreenInputSchema.parse(raw);
  const policy = KeywordPolicySchema.parse(rawPolicy);
  const normalized = input.text.toLowerCase().replace(/\s+/gu, " ").trim();
  const matchedKeywords = policy.keywords.filter((term) => matches(normalized, term));
  return KeywordResultSchema.parse({
    schemaVersion: 1,
    observation: input.observation,
    image: input.image,
    ocrOperationId: input.ocrOperationId,
    ocrTextSha256: hashString(input.text),
    policy,
    policyFingerprint: hashString(JSON.stringify(policy)),
    status: matchedKeywords.length ? "matched" : "not_matched",
    matchedKeywords,
  });
}

/** Recomputes a decision from verified text instead of trusting a caller's "matched" flag. */
export function verifySelection(raw: unknown, text: string): KeywordResult {
  const selection = KeywordResultSchema.parse(raw);
  const { observation, image, ocrOperationId, policy } = selection;
  const expected = screenKeywords({ observation, image, ocrOperationId, text }, policy);
  if (!isDeepStrictEqual(selection, expected)) {
    throw keywordFailure("SCREEN.EVIDENCE_MISMATCH");
  }
  return expected;
}
