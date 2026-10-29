import { expect, it } from "vitest";
import { RoundReportService } from "./round-report-service.js";
import type { RoundBatchRow, RoundSnapshot } from "./round-report-model.js";

const batch = (createdAt: string, extra: Partial<RoundBatchRow> = {}): RoundBatchRow => ({
  channel: "gnc",
  batchId: createdAt,
  createdAt,
  kind: "scan",
  items: 10,
  open: 0,
  completed: 9,
  review: 1,
  firstOpen: 0,
  firstSettledAt: createdAt.replace("T01", "T05"),
  ...extra,
});

const snapshot: RoundSnapshot = {
  readAt: "2026-10-20T00:00:00.000Z",
  batches: [
    batch("2026-10-07T01:00:00.000Z"),
    batch("2026-10-08T01:00:00.000Z"),
    // A follow-up list after the round: it joins the round, it does not start one.
    batch("2026-10-12T01:00:00.000Z", { kind: "list", items: 2, completed: 2, review: 0 }),
    // A requeued item of the next round is open again, but its first run settled.
    batch("2026-10-16T01:00:00.000Z", { open: 1, completed: 8 }),
    // Another channel's round in the same window is its own.
    batch("2026-10-16T01:00:00.000Z", {
      channel: "swanson",
      firstOpen: 1,
      open: 1,
      completed: 9,
      review: 0,
    }),
  ],
  scans: [
    {
      channel: "gnc",
      sourceId: "a",
      requestedAt: "2026-10-07T00:59:00.000Z",
      finishedAt: "2026-10-07T01:00:00.000Z",
      state: "complete",
    },
  ],
  pushes: [
    {
      channel: "gnc",
      runId: "marketplace-sync-gnc-2026-10-13T00:00:00.000Z",
      at: "2026-10-13T00:00:00.000Z",
      verified: 5,
      failed: 1,
      sent: 0,
    },
  ],
};

it("groups a channel's lists into rounds separated by a quiet gap", async () => {
  const service = new RoundReportService({ read: async () => snapshot });
  const { rounds } = await service.rounds({ since: "2026-10-01T00:00:00.000Z" });
  expect(rounds.map((round) => [round.roundId, round.finishedAt])).toEqual([
    ["gnc-2026-10-07T00:59", "2026-10-12T05:00:00.000Z"],
    ["gnc-2026-10-16T01:00", "2026-10-16T05:00:00.000Z"],
    ["swanson-2026-10-16T01:00", null],
  ]);
  expect(rounds[0]).toMatchObject({
    windowEnd: "2026-10-16T01:00:00.000Z",
    lists: { scan: 2, revisit: 0, list: 1 },
    products: { targets: 22, completed: 20, review: 2, open: 0 },
    brandScans: { total: 1, sources: 1, complete: 1 },
    pushed: { verified: 5, failed: 1, runIds: ["marketplace-sync-gnc-2026-10-13T00:00:00.000Z"] },
  });
  expect(rounds[1]?.products.open).toBe(1);
});

it("lets a large hand list start a round of its own", async () => {
  const service = new RoundReportService({
    read: async () => ({
      ...snapshot,
      batches: [batch("2026-10-24T01:00:00.000Z", { kind: "list", items: 2000 })],
      scans: [],
      pushes: [],
    }),
  });
  const { rounds } = await service.rounds({ since: "2026-10-01T00:00:00.000Z" });
  expect(rounds.map((round) => round.roundId)).toEqual(["gnc-2026-10-24T01:00"]);
});
