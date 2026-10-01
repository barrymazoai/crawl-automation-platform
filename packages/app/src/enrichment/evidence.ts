type EnrichmentFile = "input.json" | "prompt.json" | "response.txt" | "record.json" | "review.json";

/** Shared locations for immutable enrichment inputs, answers, results and Reviews. */
export function enrichmentKey(inputHash: string, file: EnrichmentFile) {
  return `v3/product-enrichment/${inputHash}/${file}`;
}
