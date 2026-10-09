import { createHash } from "node:crypto";
import { productDeliveryErrors } from "@crawl-automation/app";
import type { ObjectStore } from "@crawl-automation/platform";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

const WrappedProjection = z.object({
  codec: z.literal("dtc-product/2"),
  evidence: ChannelProductEvidenceSchema,
});

export async function retainedProjection(
  input: {
    objects: Pick<ObjectStore, "read">;
    references: { objectKey: string; sha256: string }[];
  },
  signal: AbortSignal,
) {
  for (const reference of input.references) {
    signal.throwIfAborted();
    const bytes = await input.objects.read(reference.objectKey, 8 * 1024 * 1024, signal);
    if (!bytes) {
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    const text = Buffer.from(bytes).toString("utf8").trimStart();
    if (!text.startsWith("{")) {
      continue;
    }
    const raw: unknown = JSON.parse(text);
    const wrapped = WrappedProjection.safeParse(raw);
    const product = ChannelProductEvidenceSchema.safeParse(
      wrapped.success ? wrapped.data.evidence : raw,
    );
    if (product.success) {
      return product.data;
    }
  }
  return null;
}
