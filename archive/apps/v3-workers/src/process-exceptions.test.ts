import { expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { describeError, listingOf, recordException, withExceptionRecord } from "./process-exceptions.js";

it("finds the most specific code and keeps the whole cause chain readable", () => {
  const nested = Object.assign(Error("Activity task failed"), { cause: ApplicationFailure.nonRetryable("Inspect retained Amazon evidence", "AMAZON.REVIEW_CODE") });
  const d = describeError(nested);
  expect(d.code).toBe("AMAZON.REVIEW_CODE");
  expect(d.message).toContain("Activity task failed");
  expect(d.message).toContain("Inspect retained Amazon evidence");
  expect(describeError({ message: "boom", applicationFailureInfo: { type: "SCRAPERAPI.REDIRECT_UNVERIFIED" } }).code).toBe("SCRAPERAPI.REDIRECT_UNVERIFIED");
  expect(describeError("plain").code).toBe("PROCESS.UNEXPECTED_ERROR");
});

it("identifies the product from the usual step inputs", () => {
  expect(listingOf({ job: { discovery: { catalogId: "r1", entry: { listingId: "B0TEST" } } } })).toEqual({ listingId: "B0TEST", requestId: "r1" });
  expect(listingOf({ sourcePlan: { owner: { listingId: "B0OWN", requestId: "r2" } } })).toEqual({ listingId: "B0OWN", requestId: "r2" });
  expect(listingOf({})).toEqual({ listingId: null, requestId: null });
});

it("recording never throws and never blocks, even when the database rejects", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const db = { query: vi.fn(async () => { throw Error("database down"); }) };
  expect(() => recordException(db, { kind: "activity", service: "t", code: "X.Y", message: "m", outcome: "step-failed" })).not.toThrow();
  await new Promise(r => setTimeout(r, 10));
  expect(log.mock.calls.some(([line]) => String(line).includes("PROCESS_EXCEPTION_NOT_STORED"))).toBe(true);
  log.mockRestore();
});

it("a wrapped step rethrows its original error and stores one exception row; success stores nothing", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const db = { query: vi.fn(async () => ({ rows: [] })) };
  const original = ApplicationFailure.nonRetryable("page missing", "AMAZON.NOT_FOUND");
  const acts = withExceptionRecord(db, "amazon-capture", {
    ok: async (_raw: unknown) => "done",
    bad: async (_raw: unknown) => { throw original; },
  });
  await expect(acts.ok({})).resolves.toBe("done");
  expect(db.query).not.toHaveBeenCalled();
  await expect(acts.bad({ job: { discovery: { catalogId: "req", entry: { listingId: "B0BAD" } } } })).rejects.toBe(original);
  await new Promise(r => setTimeout(r, 10));
  expect(db.query).toHaveBeenCalledTimes(1);
  const params = (db.query.mock.calls[0] as unknown as [string, unknown[]])[1];
  expect(params).toEqual(expect.arrayContaining(["activity", "amazon-capture", "bad", "req", "B0BAD", "AMAZON.NOT_FOUND", "step-failed"]));
  log.mockRestore();
});
