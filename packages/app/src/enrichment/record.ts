import { sha256 } from "@crawl-automation/platform";
import {
  decodeEnrichment,
  enrichmentHash,
  type EnrichmentContent,
} from "@crawl-automation/processing";
import {
  SharedEnrichmentRecordSchema,
  SHARED_ENRICHMENT_PROTOCOL,
} from "@crawl-automation/v3-contracts";
import type { EnrichmentSource } from "./ports.js";
import { enrichmentKey } from "./evidence.js";

export function enrichmentRecord(
  prepared: EnrichmentSource & EnrichmentContent,
  call: { provider: string; prompt: string; response: string },
) {
  const { inputHash, input, formulaHash, subject } = prepared;
  const candidate = decodeEnrichment(call.response, input);
  return SharedEnrichmentRecordSchema.parse({
    codec: SHARED_ENRICHMENT_PROTOCOL,
    enrichmentId: inputHash,
    formulaHash,
    inputHash,
    subject,
    provider: call.provider,
    createdAt: new Date().toISOString(),
    candidate,
    variantCode: enrichmentHash(candidate.variant),
    promptSha256: sha256(Buffer.from(call.prompt)),
    responseSha256: sha256(Buffer.from(call.response)),
    evidenceKey: enrichmentKey(inputHash, "record.json"),
  });
}
