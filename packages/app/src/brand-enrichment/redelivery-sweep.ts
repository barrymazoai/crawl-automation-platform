import { subDays } from "date-fns";
import type { Logger } from "@crawl-automation/platform";
import type { BrandRedeliveryCandidates } from "./redelivery-candidates.js";
import type { BrandProductRedelivery } from "./product-redelivery.js";

/** Reuses the manual redelivery path; one failed brand never holds up other brands. */
export class BrandRedeliverySweep {
  constructor(
    private readonly deps: {
      candidates: BrandRedeliveryCandidates;
      redelivery: Pick<BrandProductRedelivery, "deliver">;
      lookbackDays: number;
      log: Pick<Logger, "info" | "warn">;
    },
  ) {}

  async sweep(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const runIds = await this.deps.candidates.findPending(
      subDays(new Date(), this.deps.lookbackDays),
    );
    for (const runId of new Set(runIds)) {
      signal.throwIfAborted();
      try {
        const result = await this.deps.redelivery.deliver(runId, signal);
        this.deps.log.info({ runId, result }, "brand product redelivery finished");
      } catch (error) {
        signal.throwIfAborted();
        this.deps.log.warn({ runId, err: error }, "brand product redelivery failed");
      }
    }
  }
}
