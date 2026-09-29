import type { ObjectStore } from "@crawl-automation/platform";

/** An in-memory object store for tests: write-once keys, counted calls, lost acknowledgements, outages. */
export class MemoryStore implements ObjectStore {
  readonly data = new Map<string, Uint8Array>();
  reads = 0;
  writes = 0;
  /** When true, `create` stores the bytes but reports failure, as a lost acknowledgement would. */
  loseAcknowledgements = false;
  /** When true, every read fails, as an unreachable store would. */
  unavailable = false;

  async read(key: string, maxBytes: number): Promise<Uint8Array | null> {
    this.reads++;
    if (this.unavailable) {
      throw new Error("store unavailable");
    }
    const bytes = this.data.get(key);
    if (bytes && bytes.length > maxBytes) {
      throw new RangeError(`object ${key} is larger than ${maxBytes} bytes`);
    }
    return bytes ?? null;
  }

  async create(key: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    this.writes++;
    if (this.data.has(key)) {
      return "exists";
    }
    this.data.set(key, Buffer.from(bytes));
    if (this.loseAcknowledgements) {
      throw new Error("acknowledgement lost");
    }
    return "created";
  }
}
