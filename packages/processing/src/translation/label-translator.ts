import { z } from "zod";
import { textAnswer } from "../brand-research/text-runner.js";
import type { BrandTextDeps } from "../brand-research/settings.js";
import { brandResearchErrors } from "../brand-research/errors.js";

const LANGUAGE_NAMES = { de: "German" } as const;
export type LabelLanguage = keyof typeof LANGUAGE_NAMES;

const AnswerSchema = z.strictObject({
  translations: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        english: z.string().trim().min(1).max(20000),
      }),
    )
    .max(200),
});

/** The prompt for one turn: each printed text numbered, translated one for one. */
export function labelTranslationPrompt(language: LabelLanguage, texts: readonly string[]): string {
  const name = LANGUAGE_NAMES[language];
  return [
    `Translate each ${name} text printed on a dietary supplement label into English, as an English-language supplement`,
    "label would print it. Give exactly one translation per numbered text, with its index.",
    "",
    "Rules:",
    "- Translate faithfully: never add, drop, reorder or explain anything, and never correct the label.",
    "- Keep every number, unit, percentage, symbol (®, ™, *, †, %) and punctuation as printed.",
    "- Keep brand and trademark names (e.g. PepZin GI®, Quatrefolic®) and Latin botanical names unchanged.",
    "- Use the usual English name of an ingredient (Zink: Zinc; Füllstoff: Filler; Überzugsmittel: Coating agent;",
    "  Trennmittel: Anti-caking agent; davon: of which; Tagesdosis: Daily dose; Kapseln: capsules; Zutaten: Ingredients).",
    "- A text already in English is returned unchanged.",
    "",
    "Texts:",
    JSON.stringify(texts.map((text, index) => ({ index, text }))),
  ].join("\n");
}

/**
 * KAN-243 (owner 2026-11-11, Germany plan option A): printed label texts translated into English for Supply Smart, one
 * tool-free turn of the label model. The answer must translate every text exactly once.
 */
export function labelTranslator(deps: BrandTextDeps) {
  const model = `${deps.text.settings.model}/${deps.text.settings.reasoningEffort}`;
  return {
    async translate(input: { language: string; texts: readonly string[] }, signal: AbortSignal) {
      const language = z.enum(["de"]).parse(input.language);
      const answer = await textAnswer(
        deps,
        {
          task: "label-translation",
          prompt: labelTranslationPrompt(language, input.texts),
          schema: AnswerSchema,
        },
        signal,
      );
      return { translations: checkedTranslations(input.texts, answer), model };
    },
  };
}

/** Every text once, by its index; any other answer is refused, never partly used. */
export function checkedTranslations(
  texts: readonly string[],
  answer: z.infer<typeof AnswerSchema>,
): { text: string; english: string }[] {
  const byIndex = new Map(answer.translations.map((item) => [item.index, item.english]));
  if (byIndex.size !== answer.translations.length || byIndex.size !== texts.length) {
    throw brandResearchErrors.create("BRAND_RESEARCH.ANSWER_INVALID", {
      details: { task: "label-translation", reason: "not_one_per_text" },
    });
  }
  return texts.map((text, index) => {
    const english = byIndex.get(index);
    if (english === undefined) {
      throw brandResearchErrors.create("BRAND_RESEARCH.ANSWER_INVALID", {
        details: { task: "label-translation", reason: "index_missing" },
      });
    }
    return { text, english };
  });
}
