/**
 * The crawler's record of what is in Supply Smart (migration 061). "Already synced" means this ledger: a listing is
 * sent again only when its payload hash changes. Rows are keyed by channel, listing and website variant ('' none).
 */
export type MarketplaceChannel = "amazon" | "gnc" | "swanson" | "wholefoods" | "costco";
export type SyncStatus = "present" | "waiting_company" | "sent" | "verified" | "failed";

export interface SyncKey {
  channel: MarketplaceChannel;
  listingId: string;
  variantId: string | null;
}

export interface SyncRecord extends SyncKey {
  status: SyncStatus;
  collectedOperationId: string | null;
  payloadHash: string | null;
  ingestRunId: string | null;
  supplySmartProductId: string | null;
  supplySmartListingId: string | null;
  error: Record<string, unknown> | null;
  attempts: number;
  updatedAt: string;
}

export type SyncChange = SyncKey &
  Pick<SyncRecord, "status"> &
  Partial<
    Pick<
      SyncRecord,
      | "collectedOperationId"
      | "payloadHash"
      | "ingestRunId"
      | "supplySmartProductId"
      | "supplySmartListingId"
      | "error"
    >
  > & {
    /** The material (settlement) this outcome is about; required for every status except waiting_company. */
    materialAt?: string | null;
  };

export interface ProductSyncLedger {
  /** Current rows for these keys (missing keys are simply absent). */
  read(keys: SyncKey[]): Promise<SyncRecord[]>;
  /** Writes each change; `sent` (written before Supply Smart is called) counts one attempt. */
  record(changes: SyncChange[]): Promise<void>;
  /** The payload was checked again and is unchanged: only the time moves, so the sweep does not pick it again. */
  touch(entries: (SyncKey & { materialAt: string })[]): Promise<void>;
  /**
   * Marks listings found in Supply Smart before the ledger existed. Never overwrites a row that already has an
   * attempt (a real send outranks the baseline).
   */
  markPresent(keys: SyncKey[]): Promise<{ marked: number; skipped: number }>;
  counts(): Promise<{ channel: MarketplaceChannel; status: SyncStatus; count: number }[]>;
  /**
   * Rows become pending again (their material time moves before every capture): failures with this reason,
   * verified products that were sent without a formula, or attempts left `sent` (outcome unknown, e.g. a batch cut
   * off by a 429) for over 10 minutes, or the `present` baseline (a listing Supply Smart already had, usually without
   * our formula; owner 2026-10-13). Ingest is idempotent, so a resend is safe. Nothing is deleted; the old outcome
   * stays on record until the next attempt overwrites it.
   */
  reopen(filter: ReopenFilter): Promise<{ reopened: number }>;
  /** Per channel: completed products, those whose brand has a matched company, and those still to send. */
  overview(): Promise<SyncOverview[]>;
}

export interface SyncOverview {
  channel: MarketplaceChannel;
  completed: number;
  matchedBrand: number;
  pending: number;
}

export const variantKey = (variantId: string | null) => variantId ?? "";

export type ReopenFilter = { channel?: MarketplaceChannel; limit: number } & (
  { reason: string } | { withoutLabel: true } | { unfinished: true } | { present: true }
);
