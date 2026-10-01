import { EnrichmentModelOutputSchema } from "@crawl-automation/v3-contracts";
import { enrichmentErrors } from "./errors.js";
import type { EnrichmentContent } from "./protocol.js";
import { groundedCandidate } from "./grounding.js";

export const ENRICHMENT_RESPONSE_BYTES = 65_536;

/** Parse failures have JSON-safe diagnostics; grounding failures retain their own reason. */
export function decodeEnrichment(response: string, input: EnrichmentContent["input"]) {
  if (Buffer.byteLength(response) > ENRICHMENT_RESPONSE_BYTES) {
    throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", { details: { reason: "too-large" } });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(response);
  } catch (cause) {
    throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", {
      cause,
      details: { reason: "schema", issues: [{ path: [], code: "invalid_json" }] },
    });
  }
  const parsed = EnrichmentModelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(({ path, code }) => ({ path, code }));
    throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", {
      details: { reason: "schema", issues },
    });
  }
  return groundedCandidate(parsed.data, input);
}
