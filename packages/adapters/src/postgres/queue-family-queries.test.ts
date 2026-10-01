import type { Queryable } from "@crawl-automation/platform";
import type { FamilyFormulaOutcome } from "@crawl-automation/app";
import { expect, it, vi } from "vitest";
import { recordFamilyOutcome, familyOutcomes } from "./queue-family-queries.js";

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
it("reads only the requested metrics receipts with retained provenance", async () => {
  const query = vi.fn().mockResolvedValue([receipt]);
  expect(
    await familyOutcomes({ query } as Queryable, { operationIds: [receipt.operationId] }),
  ).toEqual([receipt]);
  expect(query.mock.calls[0]?.[1]).toEqual([[receipt.operationId]]);
  expect(query.mock.calls[0]?.[0]).toContain('archive_key AS "archiveKey"');
});
it("updates only the dependency status with owner and archive conflict guards", async () => {
  const query = vi.fn().mockResolvedValue([{ operation_id: receipt.operationId }]);
  await recordFamilyOutcome({ query } as Queryable, {
    ...receipt,
    status: "formula-linked",
    formulaOperationId: "amazon-label",
  });
  expect(query.mock.calls[0]?.[1]).toContain("amazon-label");
  expect(query.mock.calls[0]?.[0]).toContain("family_formula_outcome.status = 'formula-linked'");
});
it("refuses rebinding a metrics receipt to another owner or original", async () => {
  const query = vi.fn().mockResolvedValue([]);
  await expect(recordFamilyOutcome({ query } as Queryable, receipt)).rejects.toMatchObject({
    code: "QUEUE.IMPORT_CONFLICT",
  });
  expect(query.mock.calls[0]?.[0]).toContain("IS NOT DISTINCT FROM ROW");
});
