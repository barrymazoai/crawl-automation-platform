import { isDeepStrictEqual } from "node:util";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { digest, parseRecord } from "@crawl-automation/v3-review";
import type { ResultRegistry } from "../results/result-kind.js";

/** An in-memory result ledger for tests: keeps the first record per operation, like the real table. */
export class MemoryRegistry<
  TRecord extends { input: { operationId: string } },
> implements ResultRegistry<TRecord> {
  readonly data = new Map<string, TRecord>();
  writes = 0;
  /** When true, `register` stores the record but reports failure. */
  loseAcknowledgement = false;
  /** When true, `register` fails without storing anything. */
  unavailable = false;

  async read(operationId: string): Promise<TRecord | null> {
    return this.data.get(operationId) ?? null;
  }

  async register(record: TRecord): Promise<void> {
    this.writes++;
    if (this.unavailable) {
      throw new Error("ledger unavailable");
    }
    const saved = this.data.get(record.input.operationId);
    if (saved && !isDeepStrictEqual(saved, record)) {
      throw new Error("a different record is registered");
    }
    this.data.set(record.input.operationId, record);
    if (this.loseAcknowledgement) {
      throw new Error("acknowledgement lost");
    }
  }
}

/** An in-memory Review ledger for tests: failed appends, lost acknowledgements, outages. */
export class MemoryReviews {
  readonly records = new Map<string, ReviewRecord>();
  /** When true, `append` fails without storing anything. */
  failAppends = false;
  /** When true, `append` stores the Review but reports failure. */
  loseAcknowledgement = false;
  /** When true, every call fails. */
  unavailable = false;

  async read(reviewId: string): Promise<ReviewRecord | null> {
    if (this.unavailable) {
      throw new Error("Review ledger unavailable");
    }
    return this.records.get(reviewId) ?? null;
  }

  async append(raw: ReviewRecord) {
    if (this.failAppends || this.unavailable) {
      throw new Error("Review ledger unavailable");
    }
    const record = parseRecord(raw);
    this.records.set(record.reviewId, record);
    if (this.loseAcknowledgement) {
      throw new Error("acknowledgement lost");
    }
    return { registered: true as const, reviewId: record.reviewId, recordHash: digest(record) };
  }
}
