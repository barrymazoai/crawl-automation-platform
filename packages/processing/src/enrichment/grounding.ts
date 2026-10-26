import type { EnrichmentCandidate, HealthFunctionClaim } from "@crawl-automation/v3-contracts";
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
  const warnings = groundHealthFunctions(candidate, { printed, source });
  warnings.push(...groundOptionalText(candidate, source));
  const quantities = input.websiteVariant
    ? [input.title, input.websiteVariant.title, ...input.websiteVariant.options]
        .filter(Boolean)
        .join(" | ")
    : input.title;
  warnings.push(
    ...groundQuantities(candidate, quantities, Boolean(input.websiteVariant)),
    ...groundForm(candidate, printed),
    ...groundIngredients(candidate, printedStrings(input.label)),
  );
  if (warnings.length) {
    candidate.warnings = warnings.slice(0, 10);
  }
  return candidate;
}

/**
 * A health function's printed words must be printed word for word; any other claim is optional data that is dropped
 * with a warning instead of refusing the whole product (2026-10-12: 7 DTC products sat in Review over one unprinted
 * claim). Its name is a short category (owner 2026-10-26) and need not be printed; a sentence is dropped.
 */
function groundHealthFunctions(
  candidate: EnrichmentCandidate,
  evidence: { printed: string[]; source: Set<string> },
) {
  const warnings: string[] = [];
  const kept: HealthFunctionClaim[] = [];
  for (const claim of candidate.healthFunctionEvidence ?? []) {
    const word = unsupportedWord(claim.printed, evidence.source);
    const reason = word
      ? `unsupported-word:healthFunctions:${word}`
      : !evidence.printed.some((text) => text.includes(normalizedText(claim.printed)))
        ? `health-function-not-printed:${claim.printed.slice(0, 80)}`
        : healthFunctionNameProblem(claim.name);
    if (reason) {
      warnings.push(reason);
    } else if (!kept.some((entry) => sameName(entry.name, claim.name))) {
      kept.push(claim);
    }
  }
  candidate.healthFunctionEvidence = kept;
  candidate.healthFunctions = kept.map((claim) => claim.name);
  const inferred = candidate.inferredHealthFunctions ?? [];
  const named = inferred.filter((name) => !healthFunctionNameProblem(name));
  if (named.length < inferred.length) {
    warnings.push("inferred-health-function-not-a-name");
  }
  candidate.inferredHealthFunctions = named.filter(
    (name, index) => named.findIndex((other) => sameName(other, name)) === index,
  );
  return warnings;
}

/** A category is a short noun phrase ("Joint Health"); a printed claim copied as the name starts with its verb. */
const MAX_NAME_WORDS = 4;
const CLAIM_VERBS = new Set([
  "supports",
  "promotes",
  "helps",
  "maintains",
  "provides",
  "boosts",
  "enhances",
  "improves",
  "reduces",
  "contains",
  "may",
  "for",
  "to",
]);
function healthFunctionNameProblem(name: string) {
  const parts = words(name);
  return parts.length > MAX_NAME_WORDS || CLAIM_VERBS.has(parts[0] ?? "")
    ? `health-function-not-a-name:${name.slice(0, 80)}`
    : null;
}
const sameName = (left: string, right: string) => words(left).join(" ") === words(right).join(" ");

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
