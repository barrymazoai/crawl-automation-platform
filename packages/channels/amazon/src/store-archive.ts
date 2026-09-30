import { brandScanErrors } from "@crawl-automation/channels-core";
import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import { z } from "zod";
import { StoreDrawSchema } from "./store-page-browser.js";
import type { StoreDraw } from "./store-scroll.js";

const ArchiveSchema = z.object({
  codec: z.literal("amazon-store-scan/1"),
  sourceUrl: z.url(),
  provider: z.string(),
  draw: StoreDrawSchema,
  originals: z.array(z.object({ sha256: z.string(), byteSize: z.number().int() })),
});
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** One immutable page observation, including exact rendered HTML for every newly observed tile. */
export class AmazonStoreArchive {
  readonly key: string;
  constructor(
    private readonly publication: RetainedPublication,
    private readonly target: { scanId: string; url: string },
  ) {
    this.key = `v3/brand-scans/${target.scanId}/store-${sha256(Buffer.from(target.url))}.json`;
  }

  async inspect(signal: AbortSignal): Promise<StoreDraw | null> {
    const remote = await this.publication.remote.read(this.key, MAX_ARCHIVE_BYTES, signal);
    const local =
      remote ?? (await this.publication.local.read(this.key, MAX_ARCHIVE_BYTES, signal));
    if (!local) {
      return null;
    }
    const draw = this.decode(local);
    if (!remote) {
      // A local original whose PUT was interrupted is republished, never redrawn in the browser.
      await this.publication.publish(this.key, local, "application/json", signal);
    }
    return draw;
  }

  async save(draw: StoreDraw, signal: AbortSignal): Promise<StoreDraw> {
    const originals = draw.snapshots.map(({ html }) => {
      const bytes = Buffer.from(html);
      return { sha256: sha256(bytes), byteSize: bytes.byteLength };
    });
    const record = {
      codec: "amazon-store-scan/1",
      sourceUrl: this.target.url,
      provider: "ego-lite/2",
      draw,
      originals,
    };
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw brandScanErrors.create("BRAND_SCAN.PAGE_LIMIT");
    }
    await this.publication.publish(this.key, bytes, "application/json", signal);
    const saved = await this.inspect(signal);
    if (!saved) {
      throw this.unverified();
    }
    return saved;
  }

  private decode(bytes: Uint8Array): StoreDraw {
    try {
      const record = ArchiveSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
      const valid =
        record.sourceUrl === this.target.url &&
        record.originals.length === record.draw.snapshots.length &&
        record.draw.snapshots.every(({ html }, index) => {
          const original = record.originals[index];
          const content = Buffer.from(html);
          return original?.sha256 === sha256(content) && original.byteSize === content.byteLength;
        });
      if (!valid) {
        throw this.unverified();
      }
      return record.draw;
    } catch (error) {
      throw this.unverified(error);
    }
  }

  private unverified(cause?: unknown) {
    return brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", {
      cause,
      details: { key: this.key },
    });
  }
}
