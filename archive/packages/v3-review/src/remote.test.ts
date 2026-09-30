import { describe, expect, it } from "vitest";
import { fixture } from "./testing.fixture.js";
import { digest } from "./codec.js";
import { RemoteReviews, ReviewsWithRemoteFallback, type ReviewObjectStore } from "./remote.js";

class MemoryStore implements ReviewObjectStore {
    data = new Map<string, Uint8Array>(); writes = 0; failCreate = false; unavailable = false;
    async read(key: string, max: number) { if (this.unavailable) throw Error("down"); const b = this.data.get(key); if (b && b.length > max) throw Error("too large"); return b ?? null; }
    async create(key: string, bytes: Uint8Array) { this.writes++; if (this.data.has(key)) return "exists" as const; this.data.set(key, bytes); if (this.failCreate) throw Error("unknown"); return "created" as const; }
}
describe("RemoteReviews: immutable Review objects for a worker without ledger access", () => {
    it("append retains under a deterministic key and read returns the exact record", async () => {
        const store = new MemoryStore(), reviews = new RemoteReviews(store), record = fixture("review-cloud-1");
        const ack = await reviews.append(record);
        expect(ack).toEqual({ reviewId: "review-cloud-1", recordHash: digest(record), registered: true });
        expect(store.data.has("v3/ocr-reviews/review-cloud-1.json")).toBe(true);
        expect(await reviews.read("review-cloud-1")).toEqual(record);
        expect(await reviews.read("review-missing")).toBeNull();
    });
    it("an unacknowledged PUT is settled by read-back; a different record under the same id is a conflict", async () => {
        const store = new MemoryStore(), reviews = new RemoteReviews(store), record = fixture("review-cloud-2");
        store.failCreate = true;
        expect((await reviews.append(record)).registered).toBe(true);
        store.failCreate = false;
        expect((await reviews.append(record)).registered).toBe(true);
        await expect(reviews.append({ ...record, occurredAt: "2026-09-07T00:00:00.000Z" })).rejects.toMatchObject({ code: "REVIEW.CONFLICT" });
        expect(store.writes).toBe(3);
    });
    it("tampered objects and unavailable storage are typed errors, never silent nulls", async () => {
        const store = new MemoryStore(), reviews = new RemoteReviews(store), record = fixture("review-cloud-3");
        await reviews.append(record);
        store.data.set("v3/ocr-reviews/review-cloud-3.json", Buffer.from(JSON.stringify({ ...record, reviewId: "review-other" })));
        await expect(reviews.read("review-cloud-3")).rejects.toMatchObject({ code: "REVIEW.INTEGRITY" });
        store.unavailable = true;
        await expect(reviews.read("review-cloud-3")).rejects.toMatchObject({ code: "REVIEW.UNAVAILABLE" });
    });
    it("fallback reader answers from the ledger first and only then from the retained copy", async () => {
        const store = new MemoryStore(), remote = new RemoteReviews(store), record = fixture("review-cloud-4"), ledgerRecord = fixture("review-ledger-1");
        await remote.append(record);
        const ledger = { async read(id: string) { return id === "review-ledger-1" ? ledgerRecord : null; } };
        const reader = new ReviewsWithRemoteFallback(ledger, remote);
        expect(await reader.read("review-ledger-1")).toEqual(ledgerRecord);
        expect(await reader.read("review-cloud-4")).toEqual(record);
        expect(await reader.read("review-none")).toBeNull();
    });
});
