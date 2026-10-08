import type { EnrichmentCandidate } from "@crawl-automation/v3-contracts";
import { enrichmentErrors } from "./errors.js";
import { groundForm } from "./form.js";
import type { EnrichmentContent } from "./protocol.js";
import { normalizedText, printedStrings, unsupportedWord, words } from "./printed.js";
import { groundQuantities } from "./quantities.js";

/** Names are required; unsupported optional values are removed with durable warning codes. */
export function groundedCandidate(
  candidate: EnrichmentCandidate,
  input: EnrichmentContent["input"],
) {
  const printed = printedStrings({
    title: input.title,
    label: input.label,
    description: input.description ?? null,
    websiteVariant: input.websiteVariant && {
      title: input.websiteVariant.title,
      options: input.websiteVariant.options,
    },
  });
  const source = new Set(words(printed.join(" ")));
  for (const field of ["unifiedName", "baseName"] as const) {
    const word = unsupportedWord(candidate[field], source);
    if (word) {
      throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", {
        details: { reason: `unsupported-word:${field}:${word}` },
      });
    }
  }
  requireHealthFunctions(candidate, { printed, source });
  const warnings = groundOptionalText(candidate, source);
  const quantities = input.websiteVariant
    ? [input.title, input.websiteVariant.title, ...input.websiteVariant.options]
        .filter(Boolean)
        .join(" | ")
    : input.title;
  warnings.push(
    ...groundQuantities(candidate, quantities, Boolean(input.websiteVariant)),
    ...groundForm(candidate, source),
    ...groundIngredients(candidate, printedStrings(input.label)),
  );
  if (warnings.length) {
    candidate.warnings = warnings.slice(0, 10);
  }
  return candidate;
}

function requireHealthFunctions(
  candidate: EnrichmentCandidate,
  evidence: { printed: string[]; source: Set<string> },
) {
  for (const claim of candidate.healthFunctions) {
    const word = unsupportedWord(claim, evidence.source);
    if (word) {
      throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", {
        details: { reason: `unsupported-word:healthFunctions:${word}` },
      });
    }
    if (!evidence.printed.some((text) => text.includes(normalizedText(claim)))) {
      throw enrichmentErrors.create("ENRICH.OUTPUT_INVALID", {
        details: { reason: "health-function-not-printed" },
      });
    }
  }
}

/**
 * Owner 2026-10-08: main ingredients must be copied from the label's own names (anything else is dropped with a
 * warning); inferred health functions only stand in when none is printed and main ingredients exist.
 */
function groundIngredients(candidate: EnrichmentCandidate, label: string[]) {
  const warnings: string[] = [];
  const kept: string[] = [];
  for (const name of candidate.functionalIngredients ?? []) {
    const printed = label.some((text) => text.includes(normalizedText(name)));
    if (!printed) {
      warnings.push(`ingredient-not-on-label:${name.slice(0, 80)}`);
    } else if (!kept.some((entry) => normalizedText(entry) === normalizedText(name))) {
      kept.push(name);
    }
  }
  candidate.functionalIngredients = kept;
  const inferred = candidate.inferredHealthFunctions ?? [];
  if (inferred.length && (candidate.healthFunctions.length || !kept.length)) {
    warnings.push("inferred-health-function-dropped");
    candidate.inferredHealthFunctions = [];
  }
  return warnings;
}

function groundOptionalText(candidate: EnrichmentCandidate, source: Set<string>) {
  const warnings: string[] = [];
  for (const field of ["flavor", "strength"] as const) {
    const value = candidate.variant[field];
    const word = value === null ? undefined : unsupportedWord(value, source);
    if (word) {
      candidate.variant[field] = null;
      warnings.push(`unsupported-word:variant.${field}:${word}`);
    }
  }
  return warnings;
}
