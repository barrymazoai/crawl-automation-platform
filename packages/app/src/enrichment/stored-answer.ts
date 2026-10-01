import { sha256 } from "@crawl-automation/platform";
import { ENRICHMENT_RESPONSE_BYTES } from "@crawl-automation/processing";

/** Same raw-answer candidate as the text step; an oversized prefix is explicitly unreplayable. */
export function enrichmentAnswer(response: string) {
  const bytes = Buffer.from(response);
  const truncated = bytes.length > ENRICHMENT_RESPONSE_BYTES;
  const rawResponse = truncated
    ? new TextDecoder().decode(bytes.subarray(0, ENRICHMENT_RESPONSE_BYTES), { stream: true })
    : response;
  return {
    schema: "text-raw-response/1",
    value: { rawResponse, truncated, byteSize: bytes.length, sha256: sha256(bytes) },
  };
}
