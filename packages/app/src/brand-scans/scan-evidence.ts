import { z } from "zod";
import type { BrandScanReader, ChannelRegistry } from "@crawl-automation/channels-core";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import type { BrandScanStore } from "./ports.js";
import type { ScanRecord, ListingScanMetricsSchema } from "./scan-model.js";
import { ScanChannelSchema } from "./scan-model.js";
import { readScanArchive } from "./scan-evidence-archive.js";

export const ScanEvidenceInputSchema = z.strictObject({
  scanId: z.uuid(),
  archiveKey: z.string().min(1).max(1024).optional(),
});
type Attempt = z.infer<typeof ListingScanMetricsSchema>["attempts"][number];
type SavedAttempt = Attempt & { archiveKey: string };

/** Inspects recorded answers only. No capture, storage writes, SQL or scan requests. */
export class ScanEvidenceService {
  constructor(
    private readonly deps: {
      store: Pick<BrandScanStore, "get">;
      registry: ChannelRegistry;
      objects?: Pick<ObjectStore, "read"> | undefined;
    },
  ) {}

  async inspect(raw: unknown) {
    const input = ScanEvidenceInputSchema.parse(raw);
    const scan = await this.deps.store.get(input.scanId);
    if (!scan) {
      throw appErrors.create("SCAN.NOT_FOUND", { details: input });
    }
    const attempts = (scan.result?.metrics?.attempts ?? []).filter(isSaved);
    if (input.archiveKey !== undefined) {
      const attempt = attempts.find((item) => item.archiveKey === input.archiveKey);
      if (!attempt) {
        throw appErrors.create("EVIDENCE.NOT_FOUND", { details: input });
      }
      const { json } = await this.read(scan.scanId, attempt.archiveKey);
      return { scanId: scan.scanId, archiveKey: attempt.archiveKey, json };
    }
    const answers = [];
    for (const attempt of attempts) {
      answers.push(await this.describe(scan, attempt));
    }
    // Metrics are persisted when a scan settles; an in-progress inventory is not exhaustive.
    const recorded = scan.result?.metrics?.attempts !== undefined;
    return { scanId: scan.scanId, state: scan.state, recorded, answers };
  }

  private async describe(scan: ScanRecord, attempt: SavedAttempt) {
    try {
      const saved = await this.read(scan.scanId, attempt.archiveKey);
      const page = this.reader(scan).parsePage({
        body: saved.body,
        url: saved.record.url,
        page: attempt.page,
      });
      return {
        ...attempt,
        empty: page.cards === 0,
        productCount: new Set(page.products.map((product) => product.listingId)).size,
        statedTotal: page.statedTotal,
        creditCost: saved.record.creditCost,
        inspectionCode: null,
      };
    } catch (error) {
      const inspectionCode = errorCodeOf(error);
      if (!inspectionCode) {
        throw error;
      }
      return { ...attempt, productCount: null, statedTotal: null, inspectionCode };
    }
  }

  private reader(scan: ScanRecord): BrandScanReader {
    const channel = ScanChannelSchema.parse(scan.source.channel);
    const adapter = this.deps.registry.forBrandSource(channel, scan.source.url);
    if (!adapter.brandScan) {
      throw appErrors.create("BRAND_SCAN.CHANNEL_UNSUPPORTED");
    }
    return adapter.brandScan;
  }

  private read(scanId: string, archiveKey: string) {
    const prefix = `v3/brand-scans/${scanId}/`;
    if (!archiveKey.startsWith(prefix) || !/^[\w-]+\.json$/.test(archiveKey.slice(prefix.length))) {
      throw appErrors.create("EVIDENCE.NOT_FOUND", { details: { scanId, archiveKey } });
    }
    if (!this.deps.objects) {
      throw appErrors.create("EVIDENCE.READ_NOT_CONFIGURED");
    }
    return readScanArchive(this.deps.objects, archiveKey, AbortSignal.timeout(60_000));
  }
}

function isSaved(attempt: Attempt): attempt is SavedAttempt {
  return attempt.archiveKey !== null;
}
