import { PostgresBrandRedeliveryCandidates } from "@crawl-automation/adapters";
import { BrandRedeliverySweep, type BrandProductRedelivery } from "@crawl-automation/app";
import type { CoreParts } from "./core-parts.js";

export function buildBrandRedeliverySweep(
  parts: CoreParts,
  input: { redelivery: BrandProductRedelivery; lookbackDays: number },
) {
  return new BrandRedeliverySweep({
    ...input,
    candidates: new PostgresBrandRedeliveryCandidates(parts.database),
    log: parts.log.child({ service: "brand-redelivery-sweep" }),
  });
}
