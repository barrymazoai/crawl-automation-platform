import { describe, expect, it } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { defined } from "../testing/defined.js";
import { collectBoth, merge, mergeSetup, type MergeSetup } from "../testing/merge-fixture.js";
import { agreementCandidate, agreementField } from "./label-agreement-fixture.js";

const cinnamon = "Ceylon Cinnamon (Cinnamomum verum) Dried Bark";
const excipients = ["Organic Glycerin", "Water"];

const withoutFormula = (items: string[], heading?: string) => {
  const candidate = agreementCandidate(cinnamon, items);
  candidate.formula = null;
  candidate.formulaComplete = false;
  if (heading) {
    defined(candidate.otherIngredients).heading = agreementField(heading);
  }
  return candidate;
};

/** The page source under another ID, so it sorts before or after the images. */
function withPageId(setup: MergeSetup, pageId: string) {
  const rename = <T extends { id: string }>(source: T): T =>
    source.id === setup.text.id ? { ...source, id: pageId } : source;
  setup.join.manifest.sources = setup.join.manifest.sources.map(rename);
  return merge(setup, setup.entries.map(rename));
}

const itemsOf = (result: ReturnType<typeof merge>) =>
  result.otherIngredients?.items.map((item) => item.text);

describe("a page Ingredients list that differs from the image's printed list (owner 2026-10-25)", () => {
  it("keeps the image's list with a warning, and the record is collected", async () => {
    const page = agreementCandidate(cinnamon, excipients);
    defined(page.otherIngredients).heading = agreementField("Ingredients:");
    defined(page.otherIngredients).items = [cinnamon, "Water", "Malt Syrup"].map(agreementField);
    const setup = await mergeSetup([agreementCandidate(cinnamon, excipients)], page);
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    const result = merge(setup);
    expect(result).toMatchObject({
      status: "ready",
      codes: [],
      warnings: [{ id: "a-text", code: "LABEL_PRODUCT.INGREDIENTS_PAGE_DIFFERS" }],
    });
    expect(itemsOf(result)).toEqual(excipients);
    const record = await collectBoth(setup);
    expect(record.otherIngredients?.items.map((item) => item.text)).toEqual(excipients);
  });

  it.each(["a-text", "source-0b", "zz-text"])(
    "still reports two images that disagree, whatever the page ID sorts as (%s)",
    async (pageId) => {
      const setup = await mergeSetup(
        [withoutFormula(excipients), withoutFormula(["Gelatin", "Water"])],
        withoutFormula([cinnamon, ...excipients], "Ingredients:"),
      );
      setup.join.manifest.evidencePolicy = "label-image-first/7";
      expect(withPageId(setup, pageId)).toMatchObject({
        status: "review",
        codes: expect.arrayContaining(["LABEL_PRODUCT.INGREDIENTS_CONFLICT"]),
      });
    },
  );
});

describe("page Ingredients against the image with no formula on any source (owner 2026-10-25)", () => {
  const mergedWithPage = async (pageItems: string[], pageId = "a-text") => {
    const setup = await mergeSetup(
      [withoutFormula(excipients)],
      withoutFormula(pageItems, "Ingredients:"),
    );
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    return withPageId(setup, pageId);
  };

  it.each(["a-text", "zz-text"])(
    "takes the page list that adds the actives to the image's excipients (page %s)",
    async (pageId) => {
      const result = await mergedWithPage([cinnamon, "Water", "Organic Glycerin"], pageId);
      expect(result).toMatchObject({ status: "ready", codes: [] });
      expect(itemsOf(result)).toEqual([cinnamon, "Water", "Organic Glycerin"]);
    },
  );

  it("names the page-list rule when the page is compared after the image", async () => {
    const result = await mergedWithPage([cinnamon, "Water", "Organic Glycerin"], "zz-text");
    expect(result.warnings).toContainEqual({
      id: "zz-text",
      code: "LABEL_PRODUCT.INGREDIENTS_PAGE_WITHOUT_FORMULA",
    });
  });

  it("keeps the image's list when the page names none of its items", async () => {
    const result = await mergedWithPage([cinnamon]);
    expect(result).toMatchObject({ status: "ready", codes: [] });
    expect(itemsOf(result)).toEqual(excipients);
  });

  it("keeps the image's list when the page overlaps it only partly", async () => {
    const result = await mergedWithPage([cinnamon, "Water", "Malt Syrup"]);
    expect(result).toMatchObject({ status: "ready", codes: [] });
    expect(itemsOf(result)).toEqual(excipients);
  });

  it("does not apply when another source carries a formula", async () => {
    const ingredients = withoutFormula(excipients);
    ingredients.issues = [{ code: "FORMULA_MISSING", detail: "Facts panel not visible." }];
    const facts: LabelImageCandidate = agreementCandidate(cinnamon, []);
    facts.otherIngredients = null;
    facts.ingredientsComplete = false;
    facts.issues = [{ code: "INGREDIENTS_MISSING", detail: "Other Ingredients not visible." }];
    const setup = await mergeSetup(
      [ingredients, facts],
      withoutFormula([cinnamon, ...excipients], "Ingredients:"),
    );
    setup.join.manifest.evidencePolicy = "label-image-first/7";
    const result = withPageId(setup, "source-0b");
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: "LABEL_PRODUCT.INGREDIENTS_PAGE_WITHOUT_FORMULA" }),
    );
    expect(itemsOf(result)).not.toContain(cinnamon);
  });
});
