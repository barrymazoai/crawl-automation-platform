import { expect, it } from "vitest";
import { INDIA_RULES, US_RULES } from "../label/markets/market-rules.js";
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
  ({ market, formulaSource: { candidate: { formula: back } } }) as unknown as MergeState;
const pick = (imageFirst: boolean) =>
  ({ candidate: { formula: front }, imageFirst }) as unknown as MarketPick;

it("India: the same ingredient and amount named shorter is one reading of the selected formula", () => {
  expect(marketAgrees(state(INDIA_RULES), pick(false))).toBe(true);
});

it("not for the US, nor where a complete image leads (the collected record checks the shared agreement)", () => {
  expect(marketAgrees(state(US_RULES), pick(false))).toBe(false);
  expect(marketAgrees(state(INDIA_RULES), pick(true))).toBe(false);
});
