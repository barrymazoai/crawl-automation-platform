import type { ObjectStore } from "@crawl-automation/platform";
import {
  ChannelProductEvidenceSchema,
  type ChannelProductEvidence,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { retainedValue } from "./retained-value.js";

const WrappedProjection = z.object({
  codec: z.literal("dtc-product/2"),
  evidence: ChannelProductEvidenceSchema,
});

export async function retainedProjection(
  input: {
    objects: Pick<ObjectStore, "read">;
    references: { objectKey: string; sha256: string }[];
    /** Existing channel parsers for retained nonstandard projections and original HTML. */
    decode?: (raw: unknown) => ChannelProductEvidence | null;
  },
  signal: AbortSignal,
) {
  for (const reference of input.references) {
    const raw = await retainedValue(input.objects, reference, signal);
    if (raw === undefined) {
      continue;
    }
    const wrapped = WrappedProjection.safeParse(raw);
    const product = ChannelProductEvidenceSchema.safeParse(
      wrapped.success ? wrapped.data.evidence : raw,
    );
    if (product.success) {
      return product.data;
    }
    const decoded = input.decode?.(raw);
    if (decoded) {
      return ChannelProductEvidenceSchema.parse(decoded);
    }
  }
  return null;
}
