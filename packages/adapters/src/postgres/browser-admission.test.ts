import { expect, it, vi } from "vitest";
import type { Database } from "@crawl-automation/platform";
import { PostgresResourceAdmission } from "./postgres-resource-admission.js";
import { pendingBrowserExecutions } from "./pending-browser-executions.js";

const request = {
  permitId: "permit-one",
  workflowId: "workflow",
  runId: "00000000-0000-4000-8000-000000000001",
  needs: [{ resourceId: "browser", units: 1 }],
};

it("preserves the browser infrastructure reason and creates no permit on an unhealthy resource", async () => {
  const query = vi.fn().mockResolvedValue([]);
  query.mockImplementation(async (sql: string) =>
    sql.includes("SELECT capacity")
      ? [{ capacity: 1, ready: false, reason: "browser:BROWSER.UNAVAILABLE" }]
      : [],
  );
  const database: Database = {
    query,
    transaction: (work) => work({ query }),
    close: async () => undefined,
  };
  expect(await new PostgresResourceAdmission(database).reserve(request)).toEqual({
    permitId: request.permitId,
    status: "waiting",
    reason: "browser:BROWSER.UNAVAILABLE",
  });
  expect(query.mock.calls.some(([sql]) => /INSERT INTO resource_permit \(/.test(sql))).toBe(false);
});

it("keeps a prior committed grant visible even if the current browser is unavailable", async () => {
  const query = vi
    .fn()
    .mockImplementation(async (sql: string) =>
      sql.includes("SELECT request, released_at") ? [{ request, released_at: null }] : [],
    );
  const database: Database = {
    query,
    transaction: (work) => work({ query }),
    close: async () => undefined,
  };
  expect(await new PostgresResourceAdmission(database).reserve(request)).toMatchObject({
    status: "granted",
  });
  expect(query.mock.calls.some(([sql]) => sql.includes("SELECT capacity"))).toBe(false);
});

it("scopes durable recovery to ended activities on this host and its configured space", async () => {
  const query = vi.fn().mockResolvedValue([]);
  await pendingBrowserExecutions({ query }, { host: "own-host", taskSpaceId: 6 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("s.activity_ended_at IS NOT NULL"), [
    "own-host",
    "6",
  ]);
  expect(query.mock.calls[0]?.[0]).toContain("ego-single-page/1");
  expect(query.mock.calls[0]?.[0]).toContain("p.released_at IS NULL");
});
