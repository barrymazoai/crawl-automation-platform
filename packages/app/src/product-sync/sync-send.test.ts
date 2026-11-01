import { expect, it, vi } from "vitest";
import type { ProductObservationWriter } from "../product-delivery/ports.js";
import type { PlannedSync, SyncTally } from "./sync-model.js";
import { partialRun, sendBatch } from "./sync-send.js";

const item = (externalId: string, capturedAt: string) => ({
  externalId,
  capturedAt,
  price: "9.99",
});

// Supply Smart stores one snapshot per listing + captured_at + source.
it("uses one fixed snapshot source regardless of batch content", () => {
  const first = item("A", "2026-10-17T06:18:02Z");
  const second = item("B", "2026-10-20T08:35:28Z");
  const run = (items: object[]) =>
    partialRun({
      runId: "run",
      planned: items.map((item) => ({ product: { channel: "amazon" }, item })) as Parameters<
        typeof partialRun
      >[0]["planned"],
    });
  expect(run([first, second]).source).toBe("crawl-automation:marketplace-sync-v2");
  expect(run([first]).source).toBe(run([first, { ...second, unitsSold: 25 }]).source);
});

it("the ingest run starts at the batch's earliest capture and carries that source", () => {
  const planned = [
    { product: { channel: "amazon" }, item: item("B", "2026-10-20T08:35:28Z") },
    { product: { channel: "amazon" }, item: item("A", "2026-10-17T06:18:02Z") },
  ] as unknown as Parameters<typeof partialRun>[0]["planned"];
  const run = partialRun({ runId: "marketplace-sync-amazon-run", planned });
  expect(run).toEqual({
    runId: "marketplace-sync-amazon-run",
    channel: "amazon",
    scope: "partial",
    startedAt: "2026-10-17T06:18:02Z",
    source: "crawl-automation:marketplace-sync-v2",
  });
});

it("one marketplace delivery presents one snapshot key while retaining commerce and label", async () => {
  const capturedAt = "2026-10-17T06:18:02Z";
  const planned = [
    {
      product: { channel: "amazon", collection: null },
      key: { channel: "amazon", listingId: "A", variantId: null },
      item: { clientRef: "A", externalId: "A", capturedAt, price: "9.99", currency: "USD" },
      label: {
        source: "crawler-v3:product-delivery",
        submitter: { namespace: "crawler-v3", operationId: "label-A" },
        observation: { observationId: "observation-A", capturedAt },
        listing: { externalId: "A", price: "9.99", currency: "USD" },
      },
      hash: "hash",
    },
  ] as unknown as [PlannedSync];
  const snapshots: string[] = [];
  const writer = {
    ingest: vi.fn(
      async ({
        run,
        items,
      }: {
        run: { runId: string; source: string };
        items: (typeof planned)[0]["item"][];
      }) => {
        snapshots.push(`${items[0]?.externalId}|${items[0]?.capturedAt}|${run.source}`);
        return {
          runId: run.runId,
          results: [
            { clientRef: "A", status: "ok", observationSkipped: null, identity: null, error: null },
          ],
        };
      },
    ),
    label: vi.fn(async (label: NonNullable<PlannedSync["label"]>) => {
      snapshots.push(`${label.listing.externalId}|${label.observation.capturedAt}|${label.source}`);
      return {
        outcome: "created",
        operationId: "label-A",
        steps: { labelObservation: "done" },
        labelObservationId: "label-observation-A",
        labelHash: "label-hash",
        requestFingerprint: "request-hash",
        error: null,
      };
    }),
    readLabel: vi.fn(async () => ({
      found: true,
      request: { state: "completed" },
      problems: [],
      matches: { labelHash: true, requestFingerprint: true },
      observation: {
        id: "label-observation-A",
        operationId: "label-A",
        submitterNamespace: "crawler-v3",
        externalObservationId: "observation-A",
      },
    })),
    verify: vi.fn(async () => ({
      runId: "run",
      found: true,
      problems: [],
      items: [
        {
          clientRef: "A",
          recorded: true,
          ledger: { status: "ok" },
          product: { id: "product-A", identityState: "resolved" },
          listing: { id: "listing-A" },
          mismatches: [],
          problems: [],
        },
      ],
    })),
    complete: vi.fn(async () => ({ found: true, scope: "partial", problems: [] })),
  } as unknown as ProductObservationWriter;
  const tally = {
    result: { verified: 0, needsReview: 0, failed: [], runCompleted: null },
    changes: [],
  } as unknown as SyncTally;
  await sendBatch({ writer, runId: "run", planned }, tally, new AbortController().signal);
  expect(new Set(snapshots)).toEqual(
    new Set([`A|${capturedAt}|crawl-automation:marketplace-sync-v2`]),
  );
  expect(snapshots).toHaveLength(2);
  expect((writer.ingest as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].items[0]).toMatchObject({
    price: "9.99",
    currency: "USD",
  });
  expect((writer.label as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].listing).toMatchObject({
    price: "9.99",
    currency: "USD",
  });
  expect(tally.result).toMatchObject({ verified: 1, runCompleted: true, failed: [] });
});
