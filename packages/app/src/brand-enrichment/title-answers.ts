import {
  normalizePositionTitle,
  TitleClassificationSchema,
  type PositionTaxonomy,
  type KnownPosition,
  type TitleClassification,
} from "@crawl-automation/v3-contracts";
import { brandEnrichmentErrors } from "./errors.js";
export type TitleAnswer = TitleClassification & { method: "reused" | "codex" };
export function validPosition(
  item: { function: string | null; level: string | null },
  taxonomy: PositionTaxonomy,
): item is { function: string; level: string } {
  return (
    !!item.function &&
    !!item.level &&
    taxonomy.functions.includes(item.function) &&
    taxonomy.levels.includes(item.level)
  );
}
export function reuseTitles(input: {
  titles: string[];
  known: KnownPosition[];
  taxonomy: PositionTaxonomy;
}) {
  const answers = new Map<string, TitleAnswer>();
  const unknown: string[] = [];
  for (const title of input.titles) {
    const matches = input.known.filter(
      (item) => item.normalizedTitle === normalizePositionTitle(title),
    );
    const found = matches[0];
    const consistent = matches.every(
      (item) =>
        item.status === "known" && item.function === found?.function && item.level === found?.level,
    );
    if (found && consistent && validPosition(found, input.taxonomy)) {
      answers.set(title, { title, function: found.function, level: found.level, method: "reused" });
    } else {
      unknown.push(title);
    }
  }
  return { answers, unknown };
}
export function acceptTitles(input: {
  unknown: string[];
  taxonomy: PositionTaxonomy;
  answers: Map<string, TitleAnswer>;
  classified: unknown[];
}) {
  const classified = input.classified.map((item) => TitleClassificationSchema.parse(item));
  for (const item of classified) {
    if (
      !input.unknown.includes(item.title) ||
      !validPosition(item, input.taxonomy) ||
      input.answers.has(item.title)
    ) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_MATCH");
    }
    input.answers.set(item.title, { ...item, method: "codex" });
  }
  return classified;
}
