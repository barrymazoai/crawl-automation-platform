/** A store of immutable objects: each key is written once and read back. R2 and local folders implement it. */
export interface ObjectStore {
  read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  create(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<"created" | "exists">;
}
