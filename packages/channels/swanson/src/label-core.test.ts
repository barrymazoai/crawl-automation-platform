import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSwansonLabelCore } from "./label-core.js";
import { parseSwansonRenderedProduct } from "./swanson-evidence.js";

const escape = (text: string) => `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
const label =
  "Supplement Facts\nServing Size 1 Softgel\nAmount Per Serving\nBlend\n125 mg\nOther Ingredients: Gelatin, water.\n\n" +
  "Suggested Use: one daily\nWarning: consult doctor";

const ambiguous: Record<string, string> = {
  duplicate: escape(label) + escape(label),
  nested: escape(label).replace("Blend", "<b>Blend</b>"),
  "no boundary": escape(label.split("Suggested Use")[0] ?? ""),
  empty: escape(label.replace("Gelatin, water.", "")),
  script: escape(label) + "<script>ignored?</script>",
};

/** A saved Swanson page projection (the public JSON the channel parser reads). */
function savedProjection(name: string) {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  const projection = JSON.parse(readFileSync(url, "utf8"));
  const form = projection.selectedForms[0];
  return parseSwansonRenderedProduct(projection, projection.url, {
    listingId: form.productId,
    variantId: form.variantIds[0],
  });
}

// Cases carried over from the former Swanson label-core reader.
describe("Swanson label core", () => {
  it.each(["swanson-product-public.json", "swanson-second-public.json"])(
    "isolates the real label from %s without rewriting it",
    (name) => {
      const product = savedProjection(name);
      const core = extractSwansonLabelCore(
        `${product.factsCandidates[0]?.html ?? ""}\n${product.detailsHtml}`,
      );
      expect(core).toContain(
        "Other Ingredients: BSE-free gelatin (capsule), vegetable glycerine, double-distilled and deionized water.",
      );
      expect(core).not.toMatch(/Suggested Use|Warning:|Storage Instructions|Maximum Health/);
      expect(core).toContain(name.includes("second") ? "268 mg" : "125 mg");
    },
  );

  it.each(["Allergen Information: Contains: Egg", "Trademark Information: NEM® is a trademark."])(
    "ends the ingredient list at a following note (%s)",
    (note) => {
      const core = extractSwansonLabelCore(
        escape(label.replace("\n\nSuggested Use", `\n\n${note}\n\nSuggested Use`)),
      );
      expect(core).toMatch(/Other Ingredients: Gelatin, water\.$/);
      expect(core).not.toContain(note);
    },
  );

  it.each(Object.keys(ambiguous))("refuses an ambiguous page (%s)", (kind) => {
    expect(() => extractSwansonLabelCore(ambiguous[kind] ?? "")).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^LABEL_CORE\./) }),
    );
  });
});
