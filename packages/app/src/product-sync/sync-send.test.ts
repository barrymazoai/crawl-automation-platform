import { expect, it } from "vitest";
import { batchSource, partialRun } from "./sync-send.js";

const item = (externalId: string, capturedAt: string) => ({
  externalId,
  capturedAt,
  price: "9.99",
});

// Supply Smart stores one snapshot per listing + captured_at + source; a resend of a retained original keeps its
// capture time, so only a content-dependent source lets changed payloads (listing date, units) land (2026-10-27).
it("the snapshot source is the fingerprint of the batch's observation items, not its run or labels", () => {
  const first = item("A", "2026-10-17T06:18:02Z");
  const second = item("B", "2026-10-20T08:35:28Z");
  const source = batchSource([{ item: first }, { item: second }]);
  expect(source).toMatch(/^crawl-automation:marketplace-sync:[0-9a-f]{12}$/u);
  expect(batchSource([{ item: second }, { item: first }])).toBe(source);
  expect(batchSource([{ item: first }, { item: { ...second, unitsSold: 25 } }])).not.toBe(source);
  expect(batchSource([{ item: first }])).not.toBe(source);
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
    source: batchSource(planned),
  });
});
