import { expect, it, vi } from "vitest";
import type { Database, Queryable } from "@crawl-automation/platform";
import { PostgresResourceAdmission } from "./postgres-resource-admission.js";

const request = {
  permitId: "permit-reserve-failed",
  workflowId: "workflow-one",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  needs: [{ resourceId: "model", units: 1 }],
};

function fixture(answers: object[][]) {
  const query = vi.fn<Queryable["query"]>();
  for (const rows of answers) {
    query.mockResolvedValueOnce(rows);
  }
  const database: Database = {
    query: query as Queryable["query"],
    transaction: (run) => run({ query: query as Queryable["query"] }),
    close: async () => undefined,
  };
  return { query, store: new PostgresResourceAdmission(database) };
}

it("repeated release of an unknown permit succeeds without writing a grant or proof", async () => {
  const { query, store } = fixture([[], [], [], []]);
  const release = { ...request, reserveFailed: true };
  const expected = { permitId: request.permitId, status: "released", reason: "released" };
  await expect(store.release(release)).resolves.toEqual(expected);
  await expect(store.release(release)).resolves.toEqual(expected);
  expect(query).toHaveBeenCalledTimes(4);
  expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
  expect(query.mock.calls[0]?.[1]).toEqual([`permit:${request.permitId}`]);
  expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});

it.each(["workflowId", "runId", "needs"] as const)(
  "keeps exact %s ownership checks for a reserve-failure release",
  async (field) => {
    const changed = {
      workflowId: "another-workflow",
      runId: "1b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
      needs: [{ resourceId: "cpu", units: 1 }],
    };
    const { query, store } = fixture([[], [{ request }]]);
    await expect(
      store.release({ ...request, [field]: changed[field], reserveFailed: true }),
    ).rejects.toMatchObject({ code: "RESOURCE.IDENTITY_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(2);
  },
);

it("records not_executed under the row lock before the existing release proof check", async () => {
  const { query, store } = fixture([[], [{ request }], [], [{ permit_id: request.permitId }], []]);
  await expect(store.release({ ...request, reserveFailed: true })).resolves.toMatchObject({
    status: "released",
  });
  expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  const journal = query.mock.calls[2]?.[0];
  expect(journal).toContain('"executionFact":"not_executed"');
  expect(journal).toContain("ON CONFLICT DO NOTHING");
  expect(journal).toContain("NOT EXISTS");
  expect(query.mock.calls[4]?.[0]).toContain("coalesce(released_at, now())");
});

it("refuses reserve-failure release when an existing execution still lacks stop proof", async () => {
  const { query, store } = fixture([[], [{ request }], [], []]);
  await expect(store.release({ ...request, reserveFailed: true })).rejects.toMatchObject({
    code: "RESOURCE.CLEANUP_UNVERIFIED",
  });
  expect(query.mock.calls.every(([sql]) => !sql.includes("SET released_at"))).toBe(true);
});
