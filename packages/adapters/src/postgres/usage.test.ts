import { expect, it, vi } from "vitest";
import {
  createLogger,
  withMeasurementContext,
  type Database,
  type MeasurementIdentity,
  type Measurement,
} from "@crawl-automation/platform";
import type { HtmlCaptureRequest, SavedHtmlOriginal } from "@crawl-automation/app";
import { PostgresUsageMeasurements } from "./usage-measurements.js";
import { PostgresUsageReader } from "./usage-reader.js";
import { PostgresQueueAttempts } from "./queue-attempts.js";
import { insertCapture } from "./html-capture-queries.js";
import { PostgresHtmlCaptureRecords } from "./html-capture-records.js";
import { captureCreditCost } from "./html-capture-cost.js";

const identity: MeasurementIdentity = {
  channel: "gnc",
  runId: "run",
  operationId: "capture",
  sourceId: "source",
  sourceHash: null,
  workflowId: "workflow-label",
  temporalRunId: "temporal",
  scanId: null,
};
const request: HtmlCaptureRequest = {
  channel: "gnc",
  capture: {
    operationId: "capture",
    sessionId: "session",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
    url: "https://example.com/product",
  },
};
const original: SavedHtmlOriginal = {
  ...request,
  capturedAt: "2026-10-01T00:00:00.000Z",
  finalUrl: null,
  source: {
    schemaVersion: 1,
    artifactId: "html",
    observationId: "observation",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
    kind: "source-html",
    mediaType: "text/html",
    objectKey: "captures/original.html",
    sha256: "a".repeat(64),
    byteSize: 1,
    producer: { operationId: "capture", module: "capture", implementationVersion: "1" },
  },
};
const log = createLogger({ name: "test", destination: { write: () => undefined } });
const event = (cost: number | null): Measurement => ({
  ...identity,
  eventId: crypto.randomUUID(),
  kind: "capture",
  step: "fetchPage",
  startedAt: original.capturedAt,
  durationMs: 25,
  outcomeCode: "completed",
  cacheHit: false,
  providerCall: true,
  creditCost: cost,
  inputTokens: null,
  outputTokens: null,
});

function database() {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]): Promise<object[]> => []);
  const store: Database = {
    query: query as Database["query"],
    close: async () => {},
    transaction: async (work) => work(store),
  };
  return { query, store };
}

it("stores capture credits queryably and sums multiple reported costs without charging reuse", async () => {
  const { store, query } = database();
  await withMeasurementContext(
    { identity, log, events: [event(5), event(2)], record: async () => {} },
    async () => {
      await insertCapture(store, request, original);
      expect(query.mock.calls[0]?.[1]?.slice(-2)).toEqual([7, false]);
      const reuse = { ...request, capture: { ...request.capture, operationId: "consumer" } };
      await insertCapture(store, reuse, original);
      expect(query.mock.calls[1]?.[1]?.slice(-2)).toEqual([0, true]);
      expect(captureCreditCost(reuse, original)).toBe(0);
    },
  );
});

it("keeps unknown costs null, including before measurement deployment", () => {
  expect(captureCreditCost(request, original)).toBeNull();
});

it("writes credits on the actual admitted-capture completion path", async () => {
  const { store, query } = database();
  query.mockImplementation(async (sql) =>
    sql.startsWith("SELECT request")
      ? [{ request, state: "in_flight", original: null, cause_code: null }]
      : [],
  );
  await withMeasurementContext({ identity, log, events: [event(5)], record: async () => {} }, () =>
    new PostgresHtmlCaptureRecords(store).complete(request, original),
  );
  const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE html_capture"));
  expect(update?.[0]).toContain("credit_cost=$4");
  expect(update?.[1]).toEqual(["capture", original, original.capturedAt, 5, false]);
});

it("resolves a nested label owner through product_run without treating the Temporal run as the product run", async () => {
  const { store, query } = database();
  query.mockResolvedValueOnce([
    { runId: "owner-product", sourceId: "owner-source", channel: "amazon" },
  ]);
  const result = await new PostgresUsageMeasurements(store).resolve(identity);
  expect(result).toMatchObject({
    runId: "owner-product",
    channel: "amazon",
    temporalRunId: "temporal",
  });
  expect(query.mock.calls[0]?.[1]).toEqual(["run", "workflow-label"]);
});

it("persists brand request credits and provenance as one idempotent event", async () => {
  const { store, query } = database();
  const measured = { ...event(3), kind: "brand-request" as const, scanId: "scan" };
  await new PostgresUsageMeasurements(store).record(measured);
  expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (event_id) DO NOTHING");
  expect(query.mock.calls[0]?.[1]?.[11]).toBe(3);
  expect(query.mock.calls[0]?.[1]?.at(-1)).toEqual(measured);
});

it("retains two attempts of one item and does not reset a terminal attempt on duplicate finish", async () => {
  const { store, query } = database();
  const attempts = new PostgresQueueAttempts(store);
  query.mockResolvedValue([{ run_id: "first" }]);
  const first = { runId: "first", itemId: "item", channel: "gnc", attempt: 1 };
  await attempts.start(first);
  await attempts.finish({ runId: "first", outcome: "review", reason: "TEXT.CODEX_TURN_FAILED" });
  await attempts.start({ ...first, runId: "second", attempt: 2 });
  expect(
    query.mock.calls.filter(([sql]) => sql.startsWith("INSERT")).map(([, values]) => values),
  ).toEqual([
    ["first", "item", "gnc", 1],
    ["second", "item", "gnc", 2],
  ]);
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ run_id: "first" }]);
  await attempts.finish({ runId: "first", outcome: "review", reason: "TEXT.CODEX_TURN_FAILED" });
  expect(query.mock.calls.at(-2)?.[0]).toContain("outcome='running'");
});

it("rejects a duplicate attempt with conflicting identity", async () => {
  const { store } = database();
  await expect(
    new PostgresQueueAttempts(store).start({
      runId: "wrong",
      itemId: "item",
      channel: "gnc",
      attempt: 1,
    }),
  ).rejects.toMatchObject({ code: "USAGE.ATTEMPT_CONFLICT" });
});

it("summarizes from a read-only snapshot with separate aggregates and half-open time boundaries", async () => {
  const { store, query } = database();
  query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ channel: "gnc", credits: 8 }])
    .mockResolvedValueOnce([{ channel: "gnc", step: "interpretText", medianMs: 10, p90Ms: 18 }])
    .mockResolvedValueOnce([{ count: 2 }]);
  const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
  expect(await new PostgresUsageReader(store).summarize(window)).toMatchObject({
    channels: [{ credits: 8 }],
    steps: [{ medianMs: 10, p90Ms: 18 }],
    unattributedEvents: 2,
  });
  expect(query.mock.calls[0]?.[0]).toContain("READ ONLY");
  expect(query.mock.calls[1]?.[1]).toEqual([window.from, window.to, null]);
  expect(query.mock.calls[1]?.[0]).toContain("NOT EXISTS (SELECT 1 FROM usage_event");
  expect(query.mock.calls[2]?.[0]).toContain("percentile_cont(0.9)");
});
