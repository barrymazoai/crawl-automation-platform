import type { EnrichmentCandidate } from "@crawl-automation/v3-contracts";

const countUnits = "count|ct|capsules?|softgels?|tablets?|gummies|chewables?|bars?|lozenges?";

/** Counts and package sizes must come from the title, never a label serving quantity. */
export function groundQuantities(candidate: EnrichmentCandidate, title: string | null): string[] {
  const warnings: string[] = [];
  const rawTitle = title?.toLowerCase() ?? "";
  const { count, size } = candidate.variant;
  const amounts = rawTitle.matchAll(
    new RegExp(`(?<![\\p{L}\\p{N}.])(\\d+)\\s*(?:${countUnits})\\b`, "gu"),
  );
  const counts = new Set([...amounts].map((match) => Number(match[1])));
  if (count !== null && (counts.size !== 1 || !counts.has(count))) {
    candidate.variant.count = null;
    warnings.push("count-not-in-title");
  }
  if (size !== null && !printedSize(size, rawTitle)) {
    candidate.variant.size = null;
    warnings.push("size-not-in-title");
  }
  return warnings;
}

function printedSize(size: NonNullable<EnrichmentCandidate["variant"]["size"]>, title: string) {
  const unit = size.unit.toLowerCase().replace(/\./gu, "").trim();
  if (!/^[a-z\s]+$/u.test(unit)) {
    return false;
  }
  const printedUnit = new RegExp(`^${unit.split(/\s+/u).join("\\s*")}(?![\\p{L}\\p{N}])`, "u");
  const amounts = title.matchAll(/(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)\s*/gu);
  return [...amounts].some((match) => {
    const rest = title.slice(match.index + match[0].length).replace(/\./gu, "");
    return Number(match[1]) === size.value && printedUnit.test(rest);
  });
}
