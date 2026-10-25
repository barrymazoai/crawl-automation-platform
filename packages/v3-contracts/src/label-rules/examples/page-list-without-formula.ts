import type { LabelRuleExamples, PageListSubject } from "../index.js";

/** For warning rules, pass means the page list is the product's ingredients; fail keeps the image's list. */
export const pageListWithoutFormulaExamples: LabelRuleExamples<PageListSubject> = {
  pass: [
    {
      subject: {
        imageItems: ["Organic Glycerin", "Water"],
        pageItems: ["Licorice (Glycyrrhiza glabra) Dried Root", "Water", "Organic Glycerin"],
      },
      source: "B0CKD332ML recapture Review 2026-10-24: page adds the herb to the image's excipients",
    },
  ],
  fail: [
    {
      subject: {
        imageItems: [
          "Soft gel shell (beef gelatin, glycerin, water)",
          "natural lemon flavor",
          "natural mixed tocopherols. Contains fish (anchovy, sardine, mackerel).",
        ],
        pageItems: [
          "Vitamin E (as natural d-alpha tocopherol)",
          "Norwegian Fish Oil",
          "Omega-3 Fatty Acids",
          "EPA (Eicosapentaenoic Acid)",
          "DHA (Docosahexaenoic Acid)",
        ],
      },
      source: "B010OV67GU recapture Review 2026-10-24: page names only the actives, so the image wins",
    },
    {
      subject: {
        imageItems: [
          "Microcrystalline cellulose",
          "stearic acid",
          "cellulose",
          "silicon dioxide",
          "croscarmel- lose sodium",
          "starch",
          "magnesium stearate",
          "hydroxypropyl methylcellulose",
          "titanium dioxide",
          "natural peppermint flavor and polysorbate 80",
        ],
        pageItems: [
          "Tricalcium Phosphate",
          "Hydroxypropyl Methylcellulose",
          "Microcrystalline Cellulose",
          "Croscarmellose Sodium",
          "Stearic Acid",
          "Polyethylene Glycol",
          "Silica",
          "Titanium Dioxide",
          "Magnesium Stearate",
          "Peppermint Oil",
        ],
      },
      source: "B0000537ZF Review: two different excipient lists overlap only partly; the image wins",
    },
    {
      subject: {
        imageItems: ["Organic Glycerin", "Water"],
        pageItems: ["Water", "Organic Glycerin"],
      },
      source: "constructed: the same items are compared as equal or reordered, never replaced",
    },
  ],
};
