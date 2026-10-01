import {
  EnrichmentCandidateSchema,
  type EnrichmentCandidate,
} from "@crawl-automation/v3-contracts";
import { enrichmentErrors } from "./errors.js";
import type { EnrichmentContent } from "./protocol.js";

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function printedStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.toLowerCase().replace(/\s+/gu, " ")];
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(printedStrings);
  }
  return [];
}

/** Names and functions cannot introduce words absent from the product evidence. */
function supported(candidate: EnrichmentCandidate, input: EnrichmentContent["input"]) {
  const printed = printedStrings({ title: input.title, label: input.label });
  const source = new Set(words(printed.join(" ")));
  const names = [
    candidate.unifiedName,
    candidate.baseName,
    ...candidate.healthFunctions,
    candidate.variant.flavor,
    candidate.variant.strength,
  ].filter((value) => value !== null);
  if (names.some((name) => words(name).some((word) => !source.has(word)))) {
    return false;
  }
  if (
    candidate.healthFunctions.some(
      (claim) => !printed.some((text) => text.includes(claim.toLowerCase().replace(/\s+/gu, " "))),
    )
  ) {
    return false;
  }
  if (!supportedQuantity(candidate, input.title)) {
    return false;
  }
  if (!["other", "unknown"].includes(candidate.form)) {
    const form = candidate.form === "gummy" ? "gumm" : candidate.form.replace(/s$/u, "");
    if (![...source].some((word) => word.startsWith(form))) {
      return false;
    }
  }
  return true;
}

function supportedQuantity(candidate: EnrichmentCandidate, rawTitle: string | null) {
  const { count, size } = candidate.variant;
  const title = rawTitle?.toLowerCase() ?? "";
  const amounts = [
    ...title.matchAll(
      /\b(\d+)\s*(?:count|ct|capsules?|softgels?|tablets?|gummies|chewables?|bars?|lozenges?)\b/gu,
    ),
  ];
  const counts = new Set(amounts.map((match) => Number(match[1])));
  if (count !== null && (counts.size !== 1 || !counts.has(count))) {
    return false;
  }
  if (size && !title.includes(`${size.value} ${size.unit.toLowerCase()}`)) {
    return false;
  }
  return true;
}

export function decodeEnrichment(response: string, input: EnrichmentContent["input"]) {
  try {
    if (Buffer.byteLength(response) > 65_536) {
      throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID");
    }
    const candidate = EnrichmentCandidateSchema.parse(JSON.parse(response));
    if (!supported(candidate, input)) {
      throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID");
    }
    return candidate;
  } catch (cause) {
    throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", { cause });
  }
}
