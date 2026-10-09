import { describe, expect, it, vi } from "vitest";
import type { Database, Queryable } from "@crawl-automation/platform";
import { PostgresPermitStop } from "./postgres-permit-stop.js";
import { PostgresPermitExecutions } from "./postgres-permit-executions.js";
import { PostgresResourceStore } from "./postgres-resource-store.js";
import { PostgresResourceAdmission } from "./postgres-resource-admission.js";

const request = {
  permitId: "permit-one",
  workflowId: "workflow-one",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  needs: [{ resourceId: "ocr", units: 1 }],
};
const identity = { kind: "ocr" as const, executionId: "job-one", endpoint: "https://ocr.test" };

function database(answers: object[][]) {
  const query = vi.fn<Queryable["query"]>();
  for (const rows of answers) {
    query.mockResolvedValueOnce(rows);
  }
  const db: Database = {
    query: query as Queryable["query"],
    transaction: (work) => work({ query: query as Queryable["query"] }),
    close: async () => undefined,
  };
  return { db, query };
}

describe("permit stop journal", () => {
  it("also blocks legacy release commands when no executor proof exists", async () => {
    const { db, query } = database([[], [{ request }], []]);
    await expect(new PostgresResourceAdmission(db).release(request)).rejects.toMatchObject({
      code: "RESOURCE.CLEANUP_UNVERIFIED",
    });
    expect(query.mock.calls.every(([sql]) => !sql.includes("SET released_at"))).toBe(true);
  });

  it("releases the exact permit after the locked ledger verifies every stop receipt", async () => {
    const { db, query } = database([[], [{ request }], [{ permit_id: request.permitId }], []]);
    expect(await new PostgresResourceAdmission(db).release(request)).toMatchObject({
      permitId: request.permitId,
      status: "released",
    });
    expect(query.mock.calls[3]?.[0]).toContain("SET released_at");
    expect(query.mock.calls[3]?.[1]).toEqual([request.permitId]);
  });
  it("arms only an exact held owner and never starts external work", async () => {
    const { db, query } = database([[{ permit_id: request.permitId }], []]);
    await new PostgresPermitStop(db).prepare(request);
    expect(query.mock.calls[0]?.[1]).toEqual([request.permitId, request.workflowId, request.runId]);
    expect(query.mock.calls[0]?.[0]).toContain("released_at IS NULL FOR UPDATE");
    expect(query.mock.calls[1]?.[1]).toEqual([request.permitId]);
  });

  it("refuses proof for a different or released owner", async () => {
    const { db, query } = database([[]]);
    await expect(
      new PostgresPermitExecutions(db).prove(request, identity, { stopped: true }),
    ).rejects.toMatchObject({ code: "RESOURCE.IDENTITY_CONFLICT" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("preserves unknown failure as a bounded actionable result, without releasing", async () => {
    const { db, query } = database([
      [{ permit_id: request.permitId }],
      [{ state: "CLEANUP_UNVERIFIED", attempts: 3 }],
    ]);
    const cleanupFailure = { message: "OCR.TIMEOUT" };
    expect(await new PostgresPermitStop(db).verify({ ...request, cleanupFailure })).toEqual({
      permitId: request.permitId,
      state: "CLEANUP_UNVERIFIED",
      attempts: 3,
    });
    expect(query.mock.calls[1]?.[1]).toEqual([request.permitId, cleanupFailure]);
    expect(query.mock.calls.every(([sql]) => !sql.includes("SET released_at"))).toBe(true);
  });

  it("does not call a duplicate Activity a fresh execution", async () => {
    const { db } = database([[{ permit_id: request.permitId }], [], []]);
    await expect(new PostgresPermitExecutions(db).begin(request)).rejects.toMatchObject({
      code: "RESOURCE.OWNER_QUARANTINED",
    });
  });

  it("keeps exact executor identities and failure proof in the existing held-permits API", async () => {
    const cleanup = {
      state: "CLEANUP_UNVERIFIED",
      attempts: 3,
      failure: { code: "OCR.TIMEOUT" },
      executions: [{ identity, stoppedAt: null, proof: null }],
    };
    const { db } = database([
      [
        {
          permitId: request.permitId,
          workflowId: request.workflowId,
          runId: request.runId,
          resources: ["ocr"],
          grantedAt: new Date(0),
          cleanup,
        },
      ],
    ]);
    expect((await new PostgresResourceStore(db).held())[0]?.cleanup).toEqual(cleanup);
  });
});
