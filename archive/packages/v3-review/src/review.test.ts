import { describe, expect, it, vi } from "vitest";
import { ReviewRecordSchema, ReviewListQuerySchema, fingerprintOcrInput, type OcrInput } from "@crawl-automation/v3-contracts";
import { createHash } from "node:crypto";
import { canonical, digest, parseRecord, publicRecord, MAX_REVIEW_BYTES } from "./codec.js";
import { ReviewInspector } from "./inspector.js";
import { inspectRegistration } from "./registration.js";
import { fixture } from "./testing.fixture.js";
describe("passive review contracts and privacy", () => {
    it("retains complete candidate and original error, but only exposes allowlisted metadata", () => {
        const record = fixture();
        expect(parseRecord(record)).toEqual(record);
        const serialized = JSON.stringify(publicRecord(record, record.occurredAt));
        expect(serialized).not.toContain("canary");
        expect(serialized).not.toContain("Complete Formula");
        expect(serialized).toContain("RESULT.REGISTRATION_UNKNOWN");
    });
    it("hash is independent of object key order but detects candidate changes", () => {
        expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
        expect(digest(fixture())).not.toBe(digest({ ...fixture(), candidate: null }));
    });
    it("rejects lossy, cyclic, deep or oversized evidence rather than truncating", () => {
        for (const value of [undefined, NaN, Infinity, new Date(), { x: undefined }, [undefined]])
            expect(() => canonical(value)).toThrow();
        const cycle: unknown[] = [];
        cycle.push(cycle);
        expect(() => canonical(cycle)).toThrow("REVIEW.INVALID_RECORD");
        const record = fixture();
        record.rawError.message = "x".repeat(MAX_REVIEW_BYTES);
        expect(() => parseRecord(record)).toThrow("REVIEW.TOO_LARGE");
    });
    it("forbids auto retry, mismatched ownership, self blocks and executed downstream blocks", () => {
        const r = fixture();
        expect(ReviewRecordSchema.safeParse({ ...r, failure: { ...r.failure, automaticRetry: true } }).success).toBe(false);
        expect(ReviewRecordSchema.safeParse({ ...r, observation: { ...r.observation, requestId: "other" } }).success).toBe(false);
        expect(ReviewRecordSchema.safeParse({ ...r, failure: { ...r.failure, blockedBy: "upstream" } }).success).toBe(false);
        expect(ReviewRecordSchema.safeParse({ ...r, failure: { ...r.failure, executionFact: "not_executed", blockedBy: r.failure.operationId } }).success).toBe(false);
        expect(ReviewRecordSchema.safeParse({ ...r, failure: { ...r.failure, executionFact: "not_executed", blockedBy: "upstream" } }).success).toBe(true);
    });
    it("rejects missing full-candidate disposition and validates query limits/filters", () => {
        const { candidate: _candidate, ...record } = fixture();
        expect(ReviewRecordSchema.safeParse(record).success).toBe(false);
        for (const query of [{ limit: 0 }, { limit: 101 }, { before: "x' OR true" }, { autoRetry: true }])
            expect(ReviewListQuerySchema.safeParse(query).success).toBe(false);
    });
});
describe("read-only reinspection", () => {
    it("missing record and no inspection target do not call remote services", async () => {
        const inspect = vi.fn();
        await expect(new ReviewInspector({ read: async () => null }, { delivery: { inspect } }).inspect("missing")).rejects.toThrow("REVIEW.NOT_FOUND");
        expect(await new ReviewInspector({ read: async () => fixture() }, { delivery: { inspect } }).inspect("review-001")).toMatchObject({ status: "NOT_APPLICABLE", mutatesState: false });
        expect(inspect).not.toHaveBeenCalled();
    });
    it("delivery adapter receives only the recorded request ID; raw provider errors cannot leak", async () => {
        const record = fixture();
        record.failure.requestId = "00000000-0000-4000-8000-000000000001";
        record.observation = null;
        record.inspection = { kind: "workflow-delivery", requestId: record.failure.requestId };
        const reader = { read: async () => record };
        expect(await new ReviewInspector(reader).inspect(record.reviewId)).toMatchObject({ status: "NOT_CONFIGURED" });
        const inspect = vi.fn(async () => ({ decision: "HOLD", issue: "private-token-canary" }));
        const result = await new ReviewInspector(reader, { delivery: { inspect } }).inspect(record.reviewId);
        expect(inspect).toHaveBeenCalledExactlyOnceWith(record.failure.requestId);
        expect(result).toMatchObject({ status: "INSPECTED", delivery: { decision: "HOLD", hasIssue: true }, mutatesState: false, automaticRetry: false });
        expect(JSON.stringify(result)).not.toContain("canary");
        expect(await new ReviewInspector(reader, { delivery: { inspect: async () => { throw Error("secret"); } } }).inspect(record.reviewId)).toMatchObject({ status: "UNAVAILABLE" });
    });
    it("OCR adapter gets matching signed input; returns facts without result bytes or mutation", async () => {
        const record = fixture(), o = record.observation!;
        const input: OcrInput = { ...o, operationId: record.failure.operationId, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 1,
            configFingerprint: "b".repeat(64), inputFingerprint: "a".repeat(64), file: {
                schemaVersion: 1, artifactId: "file-1", observationId: o.observationId, sourceId: o.sourceId, listingId: o.listingId, variantId: null,
                sha256: "c".repeat(64), byteSize: 10, objectKey: "evidence/source.png", producer: { operationId: "crawl-1", module: "crawl", implementationVersion: "1" }, kind: "source-image", mediaType: "image/png",
            } };
        input.inputFingerprint = fingerprintOcrInput(input, text => createHash("sha256").update(text).digest("hex"));
        record.failure.inputFingerprint = input.inputFingerprint;
        record.inspection = { kind: "ocr-result", input };
        const inspect = vi.fn(async () => ({ computedLocal: true, artifactDurable: true, resultRegistered: false, record: "private" }));
        const reviewer = new ReviewInspector({ read: async () => parseRecord(record) }, { result: { inspect } });
        expect(await reviewer.inspect(record.reviewId)).toMatchObject({ status: "INSPECTED", result: { computedLocal: true, artifactDurable: true, resultRegistered: false } });
        input.inputFingerprint = "d".repeat(64);
        record.failure.inputFingerprint = input.inputFingerprint;
        expect(await reviewer.inspect(record.reviewId)).toMatchObject({ status: "UNAVAILABLE" });
        expect(inspect).toHaveBeenCalledTimes(1);
    });
    it("read-back after uncertain commit distinguishes exact, missing and conflicting registrations", async () => {
        const record = fixture();
        expect(await inspectRegistration({ read: async () => record }, record)).toMatchObject({ registered: true, mutatesState: false });
        expect(await inspectRegistration({ read: async () => null }, record)).toMatchObject({ registered: false });
        await expect(inspectRegistration({ read: async () => ({ ...record, candidate: null }) }, record)).rejects.toThrow("REVIEW.CONFLICT");
        await expect(inspectRegistration({ read: async () => { throw Error("unavailable"); } }, record)).rejects.toThrow();
    });
});
