import { labelLanguageOf } from "@crawl-automation/v3-contracts";
import { appErrors } from "../errors.js";
import type { DeliveryLabel, DeliveryLabelContent } from "../product-delivery/wire.js";
import type { MarketplaceChannel } from "./ledger.js";
import type { PlannedSync } from "./sync-model.js";

/** Translations already made, by printed text; each printed text is translated once per language. */
export interface LabelTranslationStore {
  find(language: string, texts: readonly string[]): Promise<Map<string, string>>;
  save(
    language: string,
    translations: readonly { text: string; english: string }[],
    model: string,
  ): Promise<void>;
}

/** One model turn translating printed label texts into English, one answer per text. */
export interface LabelTranslator {
  translate(
    input: { language: string; texts: readonly string[] },
    signal: AbortSignal,
  ): Promise<{ translations: { text: string; english: string }[]; model: string }>;
}

/** Texts per model turn: a label's rows and its ingredient list, for a few products at a time. */
const TURN_TEXTS = 60;

type Field = { text: string };

/**
 * KAN-243 (owner 2026-11-11, Germany plan option A): a storefront whose labels are copied in another language sends
 * them to Supply Smart in English. The printed text of every label field Supply Smart reads (serving, column headings,
 * ingredient names, the ingredients heading and list) and the main ingredients are replaced by their English
 * translation; each field's citation keeps the printed words, and nothing the crawler stores changes. A text is
 * translated once and the stored translation reused, so a resend sends the same English.
 */
export class LabelTranslation {
  constructor(
    private readonly deps: {
      store: LabelTranslationStore;
      translator: LabelTranslator;
      log: (error: unknown) => void;
    },
  ) {}

  /**
   * These products in English; the same products for an English storefront. Null when a translation could not be made:
   * nothing is sent, the products stay pending and the next round asks again (never sent in the printed language).
   */
  async inEnglish(
    channel: MarketplaceChannel,
    planned: PlannedSync[],
    signal: AbortSignal,
  ): Promise<PlannedSync[] | null> {
    const language = labelLanguageOf(channel);
    if (!language || !planned.length) {
      return planned;
    }
    try {
      const english = await this.translations(language, planned, signal);
      return planned.map((entry) => translated(entry, english));
    } catch (error) {
      signal.throwIfAborted();
      this.deps.log(error);
      return null;
    }
  }

  private async translations(language: string, planned: PlannedSync[], signal: AbortSignal) {
    const texts = [...new Set(planned.flatMap(printedTexts))];
    const english = await this.deps.store.find(language, texts);
    const missing = texts.filter((text) => !english.has(text));
    for (let start = 0; start < missing.length; start += TURN_TEXTS) {
      const turn = missing.slice(start, start + TURN_TEXTS);
      const answer = await this.deps.translator.translate({ language, texts: turn }, signal);
      await this.deps.store.save(language, answer.translations, answer.model);
      for (const { text, english: done } of answer.translations) {
        english.set(text, done);
      }
    }
    return english;
  }
}

/** A text worth translating prints a letter; amounts, percentages and footnote marks stay as printed. */
const worded = (text: string) => /\p{L}/u.test(text);

function contentFields(content: DeliveryLabelContent): Field[] {
  const formula = content.formula;
  const fields: (Field | null)[] = [
    ...(formula
      ? [
          formula.servingSize,
          formula.servingsPerContainer,
          ...formula.columns.flatMap((column) => [
            column.heading,
            ...column.rows.map((row) => row.name),
          ]),
        ]
      : []),
    content.otherIngredients?.heading ?? null,
    ...(content.otherIngredients?.items ?? []),
  ];
  return fields.filter((field): field is Field => field !== null && worded(field.text));
}

/** Every printed text this product sends that Supply Smart shows: its label fields and main ingredients. */
export function printedTexts(entry: PlannedSync): string[] {
  return [
    ...(entry.label ? contentFields(entry.label.label.content).map((field) => field.text) : []),
    ...(entry.item.mainIngredients ?? []),
    ...(entry.label?.listing.mainIngredients ?? []),
  ].filter(worded);
}

function translated(entry: PlannedSync, english: ReadonlyMap<string, string>): PlannedSync {
  const of = (text: string) => {
    if (!worded(text)) {
      return text;
    }
    const done = english.get(text);
    if (done === undefined) {
      throw appErrors.create("LABEL_TRANSLATION.MISSING");
    }
    return done;
  };
  const field = <F extends Field | null>(value: F): F =>
    value && worded(value.text) ? { ...value, text: of(value.text) } : value;
  const names = (list: string[] | undefined) => (list ? { mainIngredients: list.map(of) } : {});
  const label = entry.label ? translatedLabel(entry.label, { field, names }) : null;
  return { ...entry, item: { ...entry.item, ...names(entry.item.mainIngredients) }, label };
}

function translatedLabel(
  label: DeliveryLabel,
  at: {
    field: <F extends Field | null>(value: F) => F;
    names: (list: string[] | undefined) => { mainIngredients?: string[] };
  },
): DeliveryLabel {
  const { field, names } = at;
  const { content } = label.label;
  const formula = content.formula && {
    ...content.formula,
    servingSize: field(content.formula.servingSize),
    servingsPerContainer: field(content.formula.servingsPerContainer),
    columns: content.formula.columns.map((column) => ({
      ...column,
      heading: field(column.heading),
      rows: column.rows.map((row) => ({ ...row, name: field(row.name) })),
    })),
  };
  const other = content.otherIngredients && {
    heading: field(content.otherIngredients.heading),
    items: content.otherIngredients.items.map(field),
  };
  return {
    ...label,
    listing: { ...label.listing, ...names(label.listing.mainIngredients) },
    label: { ...label.label, content: { ...content, formula, otherIngredients: other } },
  };
}
