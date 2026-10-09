import { describe, expect, it } from "vitest";
import {
  LabelCollectedProductSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { collectBoth, merge, mergeSetup } from "../testing/merge-fixture.js";

// Owner 2026-10-09: a complete label image's ingredient list wins over page text that lists other ingredients.
describe("complete image over page ingredient text (/7)", () => {
  const pageText = () => {
    const text = labelCandidate();
    defined(text.otherIngredients?.items[0]).text = "Different syrup";
    return text;
  };

  it("collects the image's ingredients and keeps the page difference as a warning", async () => {
    const setup = await mergeSetup([labelCandidate()], pageText());
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    const record = LabelCollectedProductSchema.parse(await collectBoth(setup));
    expect(record.otherIngredients?.items[0]?.text).toBe("Malt Syrup");
    expect(record.otherIngredients?.heading.citation.kind).toBe("image");
    expect(record.warnings).toContainEqual({
      id: "a-text",
      code: "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
    });
    expect(LabelCollectedProductSchema.safeParse({ ...record, warnings: [] }).success).toBe(false);
  });

  it("still blocks page text listing ingredients when the image confirms there are none", async () => {
    const none: LabelImageCandidate = {
      ...labelCandidate(),
      otherIngredients: null,
      ingredientDeclaration: {
        protocol: "label-visual-wire/3",
        state: "none_printed",
        wholeLabelVisible: true,
        allowNoOtherIngredientsSection: true,
      },
    };
    const setup = await mergeSetup([none], pageText());
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    expect(merge(setup).status).toBe("review");
  });

  it("still blocks a page formula that differs from the image", async () => {
    const text = labelCandidate();
    defined(defined(text.formula?.columns[0]?.rows[5]).amount).text = "201 mg";
    const setup = await mergeSetup([labelCandidate()], text);
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    expect(merge(setup).codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
  });
});
