import { TitleClassificationSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { checkedAnswer } from "./answer.js";
import { invalidAnswer } from "./errors.js";
import type { TitlesInput } from "./inputs.js";

export const TitlesAnswerSchema = z.object({ items: z.array(TitleClassificationSchema) });

export function checkTitleAnswer(raw: unknown, input: TitlesInput) {
  const { items } = checkedAnswer(TitlesAnswerSchema, raw, "titles");
  const seen = new Set<string>();
  for (const item of items) {
    if (
      !input.titles.includes(item.title) ||
      seen.has(item.title) ||
      !input.taxonomy.functions.includes(item.function) ||
      !input.taxonomy.levels.includes(item.level)
    ) {
      invalidAnswer("titles", "unknown_title_duplicate_or_off_taxonomy");
    }
    seen.add(item.title);
  }
  return items;
}
