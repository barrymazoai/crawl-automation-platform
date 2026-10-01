import { EnrichmentCandidateSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { enrichmentPrompt, type EnrichmentContent } from "./protocol.js";

/** The label text app-server client's structured output protocol, without SDK or tool calls. */
export function enrichmentModelRequest(prepared: EnrichmentContent) {
  return {
    operationId: `enrich-${prepared.inputHash}`,
    prompt: enrichmentPrompt(prepared.input),
    outputSchema: z.toJSONSchema(EnrichmentCandidateSchema),
  };
}
