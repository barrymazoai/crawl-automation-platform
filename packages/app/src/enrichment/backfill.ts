import { enrichmentErrors, enrichmentHash } from "@crawl-automation/processing";
import {
  EnrichmentRequestSchema,
  type EnrichmentRequest,
  type SharedEnrichmentRecord,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { EnrichmentRepository, EnrichmentStarter } from "./ports.js";

export const EnrichmentBackfillSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  approvedCount: z.number().int().min(1).max(100),
  products: z.array(EnrichmentRequestSchema).min(1).max(100).optional(),
});

/** Manual, bounded dispatch only. No timer, polling loop, capture or business retry. */
export class EnrichmentBackfill {
  constructor(
    private readonly repository: Pick<EnrichmentRepository, "missing"> & {
      readSubject?(request: EnrichmentRequest): Promise<SharedEnrichmentRecord | null>;
    },
    private readonly starter: EnrichmentStarter,
  ) {}

  list(limit: number) {
    return this.repository.missing(z.number().int().min(1).max(100).parse(limit));
  }

  result(raw: EnrichmentRequest) {
    if (!this.repository.readSubject) {
      throw enrichmentErrors.create("ENRICH.SETTINGS_MISSING");
    }
    return this.repository.readSubject(EnrichmentRequestSchema.parse(raw));
  }

  async run(raw: z.infer<typeof EnrichmentBackfillSchema>) {
    const input = EnrichmentBackfillSchema.parse(raw);
    if (
      input.limit !== input.approvedCount ||
      (input.products && input.products.length > input.limit)
    ) {
      throw enrichmentErrors.create("ENRICH.BACKFILL_INVALID");
    }
    const selected = input.products ?? (await this.list(input.limit));
    if (selected.length > input.approvedCount) {
      throw enrichmentErrors.create("ENRICH.BACKFILL_INVALID");
    }
    const unique = new Map(selected.map((product) => [enrichmentHash(product), product]));
    const started = [];
    for (const product of unique.values()) {
      started.push(await this.starter.start(product));
    }
    return { approvedCount: input.approvedCount, selected: unique.size, started };
  }
}
