import { describe, expect, it, vi } from "vitest";
import { LabelTranslation, printedTexts, type LabelTranslationStore } from "./label-translation.js";
import type { PlannedSync } from "./sync-model.js";

const signal = () => new AbortController().signal;
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("missing in test");
  }
  return value;
}
const field = (text: string) => ({
  text,
  sourceId: "source-1",
  citation: { kind: "image" as const, evidence: text },
});

/** Doctor's Best PepZinGl on amazon.de (B09LR81NNL, 2026-11-11): its German importer label as copied. */
function planned(): PlannedSync {
  const content = {
    codec: "collected-product/5",
    formula: {
      drugFacts: null,
      servingSize: null,
      servingsPerContainer: null,
      columns: [
        {
          heading: field("Tagesdosis (2 Kapseln)"),
          dailyValueHeading: field("%NRV*"),
          rows: [
            {
              kind: "nutrient",
              name: field("davon Zink"),
              amount: field("16mg"),
              dailyValue: field("160%"),
            },
          ],
        },
      ],
    },
    otherIngredients: {
      heading: field("Zutaten:"),
      items: [field("Zink-L-Carnosin-Komplex (PepZin GI®), Füllstoff: mikrokristalline Cellulose")],
    },
  };
  return {
    item: { mainIngredients: ["davon Zink"] },
    label: { listing: { mainIngredients: ["davon Zink"] }, label: { content } },
  } as unknown as PlannedSync;
}

const ENGLISH: Record<string, string> = {
  "Tagesdosis (2 Kapseln)": "Daily dose (2 capsules)",
  "davon Zink": "of which Zinc",
  "Zutaten:": "Ingredients:",
  "Zink-L-Carnosin-Komplex (PepZin GI®), Füllstoff: mikrokristalline Cellulose":
    "Zinc L-carnosine complex (PepZin GI®), Filler: microcrystalline cellulose",
};

function memoryStore(): LabelTranslationStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    find: async (_language, texts) =>
      new Map(
        texts.flatMap((text) => {
          const english = rows.get(text);
          return english === undefined ? [] : [[text, english] as const];
        }),
      ),
    save: async (_language, translations) => {
      for (const { text, english } of translations) {
        rows.set(text, english);
      }
    },
  };
}

const translator = () => ({
  translate: vi.fn(async (input: { texts: readonly string[] }) => ({
    translations: input.texts.map((text) => ({ text, english: ENGLISH[text] ?? text })),
    model: "gpt-label/high",
  })),
});

describe("label translation before delivery (KAN-243, Germany plan option A)", () => {
  it("sends amazon.de's printed German in English and keeps each citation as printed", async () => {
    const model = translator();
    const service = new LabelTranslation({ store: memoryStore(), translator: model, log: vi.fn() });
    const [sent] = required(await service.inEnglish("amazon-de", [planned()], signal()));
    const label = required(required(sent).label);
    const content = label.label.content;
    const column = required(required(content.formula).columns[0]);
    const other = required(content.otherIngredients);
    expect(column.heading).toMatchObject({
      text: "Daily dose (2 capsules)",
      citation: { kind: "image", evidence: "Tagesdosis (2 Kapseln)" },
    });
    expect(column.rows[0]).toMatchObject({
      name: { text: "of which Zinc", citation: { evidence: "davon Zink" } },
      amount: { text: "16mg" },
      dailyValue: { text: "160%" },
    });
    expect(required(column.dailyValueHeading).text).toBe("%NRV*");
    expect(other.heading.text).toBe("Ingredients:");
    expect(other.items.map((item) => item.text)).toEqual([
      "Zinc L-carnosine complex (PepZin GI®), Filler: microcrystalline cellulose",
    ]);
    expect(required(sent).item.mainIngredients).toEqual(["of which Zinc"]);
    expect(label.listing.mainIngredients).toEqual(["of which Zinc"]);
    // Amounts and percentages are never sent to the model.
    expect(model.translate.mock.calls[0]?.[0].texts).toEqual([
      "Tagesdosis (2 Kapseln)",
      "davon Zink",
      "Zutaten:",
      "Zink-L-Carnosin-Komplex (PepZin GI®), Füllstoff: mikrokristalline Cellulose",
    ]);
  });

  it("translates a printed text once: a later round reuses the stored English", async () => {
    const model = translator();
    const service = new LabelTranslation({ store: memoryStore(), translator: model, log: vi.fn() });
    await service.inEnglish("amazon-de", [planned()], signal());
    await service.inEnglish("amazon-de", [planned()], signal());
    expect(model.translate).toHaveBeenCalledTimes(1);
  });

  it("leaves English storefronts exactly as they were, without a model turn", async () => {
    const model = translator();
    const service = new LabelTranslation({ store: memoryStore(), translator: model, log: vi.fn() });
    const products = [planned()];
    for (const channel of ["amazon", "amazon-uk", "amazon-ca", "amazon-in", "gnc"] as const) {
      expect(await service.inEnglish(channel, products, signal())).toBe(products);
    }
    expect(model.translate).not.toHaveBeenCalled();
  });

  it("sends nothing when a translation fails, and says why", async () => {
    const log = vi.fn();
    const failing = { translate: vi.fn(async () => Promise.reject(new Error("model down"))) };
    const service = new LabelTranslation({ store: memoryStore(), translator: failing, log });
    expect(await service.inEnglish("amazon-de", [planned()], signal())).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: "model down" }));
  });

  it("collects the label fields Supply Smart shows and the main ingredients", () => {
    expect(new Set(printedTexts(planned()))).toEqual(new Set(Object.keys(ENGLISH)));
  });
});
