import { expect, it, vi } from "vitest";
import { reconcileFamilyFormulas } from "./reconcile-family-formulas.js";
import type { FamilyFormulaOutcome } from "./family-formula-outcome.js";

const receipt: FamilyFormulaOutcome = {
  operationId: "wf-capture",
  runId: "run",
  brandId: "brand",
  channel: "wholefoods",
  listingId: "B0096M5PBW",
  variantId: null,
  archiveKey: "retained/wf.html",
  status: "formula-pending",
  formulaOperationId: null,
};
it.each(["formula-pending", "no-amazon-source", "metrics-complete"] as const)(
  "links an existing Amazon formula to %s without recapturing or queueing",
  async (status) => {
    let saved: FamilyFormulaOutcome = { ...receipt, status };
    const store = {
      familyOutcomes: vi.fn(async () => [saved]),
      findFamilyFormula: vi.fn(async () => ({ operationId: "amazon-label" })),
      recordFamilyOutcome: vi.fn(async (outcome: FamilyFormulaOutcome) => {
        saved = outcome;
      }),
    };
    expect(await reconcileFamilyFormulas(store, { operationIds: [receipt.operationId] })).toEqual([
      { ...receipt, status: "formula-linked", formulaOperationId: "amazon-label" },
    ]);
    expect(store.findFamilyFormula).toHaveBeenCalledExactlyOnceWith({
      channels: ["amazon"],
      listingId: receipt.listingId,
      variantId: null,
    });
    await reconcileFamilyFormulas(store, { operationIds: [receipt.operationId] });
    expect(store.recordFamilyOutcome).toHaveBeenCalledOnce();
  },
);
it("leaves the receipt pending if Amazon has no formula, without retrying its operation", async () => {
  const store = {
    familyOutcomes: async () => [receipt],
    findFamilyFormula: async () => null,
    recordFamilyOutcome: vi.fn(),
  };
  expect(await reconcileFamilyFormulas(store, { operationIds: [receipt.operationId] })).toEqual([
    receipt,
  ]);
  expect(store.recordFamilyOutcome).not.toHaveBeenCalled();
});
