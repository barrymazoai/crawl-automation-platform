import { expect, it, vi } from "vitest";
import { orderedProgressKey } from "@crawl-automation/processing";
// Reuse retained processing fixtures to verify identity at the application boundary.
// eslint-disable-next-line no-restricted-imports
import { orderedFixture } from "../../../processing/src/label/ordered-fixture.js";
import { labelReviewDiagnostics } from "./label-review-diagnostics.js";

const signal = () => AbortSignal.timeout(5_000);
async function setup() {
  const fixture = await orderedFixture();
  const states = [{ id: "source-0", status: "not_matched" }];
  const key = orderedProgressKey(fixture.input, states);
  const report = { request: { input: fixture.input, states }, outcomes: [], codes: [] };
  const files = new Map([[key, Buffer.from(JSON.stringify(report))]]);
  const objects = { read: vi.fn(async (key: string) => files.get(key) ?? null) };
  return { report, files, objects, key, at: { input: fixture.input, states } };
}

it("retains old reports without a summary and rejects reports for another task", async () => {
  const test = await setup();
  expect(await labelReviewDiagnostics(test.objects, test.at, signal())).not.toHaveProperty(
    "sourceOutcomes",
  );
  test.report.request.input = { ...test.at.input, operationId: "foreign-label" };
  test.files.set(test.key, Buffer.from(JSON.stringify(test.report)));
  await expect(labelReviewDiagnostics(test.objects, test.at, signal())).rejects.toMatchObject({
    code: "PIPELINE.REVIEW_UNVERIFIED",
  });
});

it("does not fabricate outcomes when the exact historical prefix has no report", async () => {
  const test = await setup();
  test.objects.read.mockResolvedValue(null);
  expect(await labelReviewDiagnostics(test.objects, test.at, signal())).toEqual({});
  expect(test.objects.read).toHaveBeenCalledExactlyOnceWith(
    test.key,
    2 * 1024 * 1024,
    expect.any(AbortSignal),
  );
});

it("rejects an oversized retained summary rather than copying it into Review JSON", async () => {
  const test = await setup();
  test.files.set(
    test.key,
    Buffer.from(
      JSON.stringify({
        ...test.report,
        sourceOutcomes: {
          total: 21,
          omitted: 0,
          sources: Array.from({ length: 21 }, () => ({
            sourceId: "image",
            kind: "image",
            status: "not_matched",
            reason: "no_text",
          })),
        },
      }),
    ),
  );
  await expect(labelReviewDiagnostics(test.objects, test.at, signal())).rejects.toMatchObject({
    name: "ZodError",
  });
});
