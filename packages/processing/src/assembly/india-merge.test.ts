import { expect, it } from "vitest";
import { US_FACTS, type LabelFormatId } from "@crawl-automation/v3-contracts";
import { INDIA_RULES, US_RULES, sourcesMarket } from "../label/markets/market-rules.js";
import { marketAgrees, type MarketPick } from "./market-merge.js";
import type { MergeState } from "./merge-state.js";

/**
 * KAN-243 B09DKW81VV (amazon.in rerun 2026-11-07): the tablet read on two images, its ingredient named two ways. The
 * whole product was replayed on Server 一 with the stored answers: a Review on 0611176c, collected with this rule.
 */
const formula = (serving: string, name: string) => ({
  servingSize: { text: serving, evidence: serving },
  servingsPerContainer: null,
  drugFacts: null,
  columns: [
    {
      heading: null,
      rows: [
        {
          name: { text: name, evidence: name },
          amount: { text: "1500 mcg", evidence: "1500 mcg" },
        },
      ],
    },
  ],
});
const back = formula("1 tablet", "Vitamin B12 (Methylcobalamin IP)");
const front = formula("film coated tablet", "Methylcobalamin IP");

const state = (market: typeof US_RULES) =>
  ({
    market,
    formulaSource: { kind: "image", candidate: { formula: back } },
  }) as unknown as MergeState;
const pick = (imageFirst: boolean, kind: "image" | "text" = "image") =>
  ({ entry: { kind }, candidate: { formula: front }, imageFirst }) as unknown as MarketPick;

it("India: the same ingredient and amount named shorter is one reading of the selected formula", () => {
  expect(marketAgrees(state(INDIA_RULES), pick(false))).toBe(true);
});

/**
 * KAN-243 B0F2HZJ24W (spot check 2026-11-07): Vitamin D3 60,000 IU read complete on the front and the back, named
 * longer on the back, was joined as two sections (D3 twice). Between two label images it is one formula even where a
 * complete image leads: the collected record's check accepts the same (sameIndianIngredients in v3-contracts).
 */
it("India: two label images agree even where a complete image leads; a page there still does not", () => {
  expect(marketAgrees(state(INDIA_RULES), pick(true))).toBe(true);
  expect(marketAgrees(state(INDIA_RULES), pick(true, "text"))).toBe(false);
});

it("not for the US", () => {
  expect(marketAgrees(state(US_RULES), pick(false))).toBe(false);
  expect(marketAgrees(state(US_RULES), pick(true))).toBe(false);
});

/** KAN-243 (2026-11-07): from 0611176c a US product's two US sources counted the US format twice: India rules. */
it("a product whose every source is read in the US format alone is merged with the US rules", () => {
  const image = (formats: LabelFormatId[]) => ({
    kind: "image" as const,
    task: {
      input: {
        selection: { policy: { version: "label-keywords/2" as const, formats, keywords: [] } },
      },
    },
  });
  const page = { kind: "text" as const, task: { labelFormats: [US_FACTS] } };
  expect(sourcesMarket([image([US_FACTS]), image([US_FACTS]), page])).toBe(US_RULES);
  expect(sourcesMarket([image([US_FACTS, "in-composition/2"]), image([US_FACTS])])).toBe(
    INDIA_RULES,
  );
});
