import { PostgresFormulaLinks } from "@crawl-automation/adapters";
import { SiblingFormulaReuse, formulaFamilies } from "@crawl-automation/app";
import type { CoreParts } from "./core-parts.js";
import type { LabelParts } from "./label/label-parts.js";
/** Sibling formula reuse; a page without facts text is checked with its facts image's OCR text (OCR ledger). */
export function siblingReuseService(parts: CoreParts & { label: LabelParts }): SiblingFormulaReuse {
  return new SiblingFormulaReuse({
    index: parts.formulaIndex,
    families: formulaFamilies(parts.registry),
    links: new PostgresFormulaLinks(parts.database),
    labelImages: {
      verifiedText: (selection, signal) =>
        parts.label.stores.ocrText.verifiedText(selection, signal),
    },
  });
}
