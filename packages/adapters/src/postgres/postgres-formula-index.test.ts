import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresFormulaIndex } from "./postgres-formula-index.js";

function setup(rows: object[]) {
  const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => rows);
  return { index: new PostgresFormulaIndex({ query } as unknown as Queryable), query };
}
const member = {
  channels: ["swanson"],
  listingId: "ribose-60",
  variantId: "46318812168330",
  memberUrl: "https://www.swansonvitamins.com/p/ribose-60?variant=46318812168330",
};

describe("formula index identity lookup (database port unit)", () => {
  it("returns the saved numeric identity and binds the exact member URL and variant", async () => {
    const { index, query } = setup([
      { operation_id: "formula-60", listing_id: "8572274245770", variant_id: member.variantId },
    ]);
    expect(await index.findForMember(member)).toEqual({
      operationId: "formula-60",
      listingId: "8572274245770",
      variantId: member.variantId,
    });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual([member.channels, member.listingId, member.variantId, member.memberUrl]);
    expect(sql).toContain("product_history_source");
    expect(sql).toContain("p.record->'observation'->>'variantId' IS NOT DISTINCT FROM $3::text");
    expect(sql).toContain("h.record->'owner'->>'runId' = p.record->'observation'->>'requestId'");
    expect(sql).toContain("h.record->'owner'->>'sourceId' = p.record->'observation'->>'sourceId'");
  });
  it("returns no match when the saved evidence cannot resolve the requested identity", async () => {
    expect(await setup([]).index.findForMember(member)).toBeNull();
  });
  it("reports seen and queued independently without writing to the queue", async () => {
    const { index, query } = setup([{ seen: true, queued: false }]);
    expect(await index.familyCoverage([member])).toEqual({
      scope: "enumerated-family",
      members: [
        {
          listingId: member.listingId,
          variantId: member.variantId,
          url: member.memberUrl,
          seen: true,
          queued: false,
        },
      ],
    });
    expect(query.mock.calls[0]?.[0]).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});
