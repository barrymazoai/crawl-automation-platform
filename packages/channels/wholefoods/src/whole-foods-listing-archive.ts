import { createHash } from "node:crypto";
import { brandScanErrors } from "@crawl-automation/channels-core";
import {
  ListScrollResultSchema,
  EgoFailureSchema,
  type BrowserPage,
  type ObjectStore,
} from "@crawl-automation/platform";
import { z } from "zod";

const RecordSchema = z.object({
  codec: z.literal("brand-scan-browser-page/1"),
  url: z.string(),
  finalUrl: z.string(),
  capturedAt: z.string(),
  sha256: z.string(),
  byteSize: z.number().int(),
  provider: z.string(),
  storeId: z.string(),
  scroll: ListScrollResultSchema,
  ready: z.boolean().optional(),
  status: z.number().int().nullable().optional(),
  readinessFailure: EgoFailureSchema.nullable().optional(),
});
/** How a browser-drawn listing page was read: where, for which store, and how its scrolling ended. */
export type ListingRecord = z.infer<typeof RecordSchema>;

export interface ArchivedListing {
  html: string;
  record: ListingRecord;
  key: string;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unverified = (key: string) =>
  brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", { details: { key } });

/**
 * One browser-drawn listing page of a brand scan, kept in R2 next to the scan's other pages
 * (`v3/brand-scans/<scanId>/<label>.html` and `.record.json`) and read back before it is parsed. A page already
 * archived for this scan is read from the archive, not drawn again.
 */
export class ListingArchive {
  private readonly body: string;
  private readonly recordKey: string;
  private readonly maxBytes: number;

  constructor(
    private readonly remote: ObjectStore,
    place: { scanId: string; label: string; maxBytes: number },
  ) {
    const prefix = `v3/brand-scans/${place.scanId}/${place.label}`;
    this.body = `${prefix}.html`;
    this.recordKey = `${prefix}.record.json`;
    this.maxBytes = place.maxBytes;
  }

  /** The archived page when its record and bytes agree; null when nothing is archived; an error when they differ. */
  async inspect(signal: AbortSignal): Promise<ArchivedListing | null> {
    const recordBytes = await this.remote.read(this.recordKey, this.maxBytes, signal);
    const bytes = await this.remote.read(this.body, this.maxBytes, signal);
    if (!recordBytes) {
      // Bytes without a record are an archive that never finished: refused, never silently redone.
      if (bytes) {
        throw unverified(this.body);
      }
      return null;
    }
    const record = RecordSchema.parse(JSON.parse(Buffer.from(recordBytes).toString("utf8")));
    if (!bytes || digest(bytes) !== record.sha256) {
      throw unverified(this.body);
    }
    return { html: Buffer.from(bytes).toString("utf8"), record, key: this.body };
  }

  /** Writes the page, then its record; each is read back before the page counts as archived. */
  async save(
    drawn: { page: BrowserPage; url: string; provider: string; storeId: string },
    signal: AbortSignal,
  ): Promise<ArchivedListing> {
    const bytes = Buffer.from(drawn.page.html);
    const record: ListingRecord = {
      codec: "brand-scan-browser-page/1",
      url: drawn.url,
      finalUrl: drawn.page.url,
      capturedAt: new Date().toISOString(),
      sha256: digest(bytes),
      byteSize: bytes.byteLength,
      provider: drawn.provider,
      storeId: drawn.storeId,
      scroll: drawn.page.scroll,
      ready: drawn.page.ready,
      status: drawn.page.status,
      readinessFailure: drawn.page.readinessFailure,
    };
    await this.writeOnce(this.body, bytes, { mediaType: "text/html", signal });
    const recordBytes = Buffer.from(JSON.stringify(record));
    await this.writeOnce(this.recordKey, recordBytes, { mediaType: "application/json", signal });
    const saved = await this.inspect(signal);
    if (!saved) {
      throw unverified(this.body);
    }
    return saved;
  }

  private async writeOnce(
    key: string,
    bytes: Uint8Array,
    write: { mediaType: string; signal: AbortSignal },
  ) {
    await this.remote.create(key, bytes, write.mediaType, write.signal);
    const saved = await this.remote.read(key, bytes.byteLength, write.signal);
    if (!saved || digest(saved) !== digest(bytes)) {
      throw unverified(key);
    }
  }
}
