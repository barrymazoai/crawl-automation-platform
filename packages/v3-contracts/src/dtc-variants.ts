import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";
import { ChannelPlanInputSchema } from "./channel-plan.js";
import { ChannelProductEvidenceSchema } from "./channel-evidence.js";

/** Website identity survives even when a variant's formula evidence is unresolved. */
const member = {
  operationId: ExecutionIdSchema,
  variant: ChannelProductEvidenceSchema.shape.variants.element,
  evidence: z.array(z.string()).max(200),
};
export const DtcVariantHandoffSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...member, status: z.literal("ready"), planned: z.strictObject({
    status: z.literal("captured"), sourcePlan: ChannelPlanInputSchema,
    factsComplete: z.boolean(), labelText: z.string().max(200_000).nullable(),
    family: z.unknown(),
  }) }),
  z.strictObject({ ...member, status: z.literal("review"),
    code: z.literal("DTC.VARIANT_EVIDENCE"), reason: z.string().min(1).max(4000) }),
]);
export const DtcVariantHandoffsSchema = z.array(DtcVariantHandoffSchema).min(1).max(200);
export type DtcVariantHandoff = z.infer<typeof DtcVariantHandoffSchema>;
