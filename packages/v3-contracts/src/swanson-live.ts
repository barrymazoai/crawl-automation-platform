import { z } from "zod";
import { CatalogDiscoverySchema } from "./catalog.js";
import { ExecutionIdSchema, VersionTagSchema } from "./artifacts.js";
import { ChannelSavedLabelWorkflowInputSchema } from "./channel-label.js";
import { ChannelPlanInputSchema } from "./channel-plan.js";
import { ResourceGateSchema } from "./resources.js";

/** Family discovery is not a selected SKU. The actual variant is established by capture. */
export const SwansonProductJobSchema = z.strictObject({ codec: z.literal("swanson-product-job/1"), discovery: CatalogDiscoverySchema,
  familyDiscovery: CatalogDiscoverySchema.optional(),
  sessionId: ExecutionIdSchema, operationId: ExecutionIdSchema,
  queues: z.strictObject({ capture: VersionTagSchema, plan: VersionTagSchema, file: VersionTagSchema, label: VersionTagSchema, review: VersionTagSchema }),
  resources: ResourceGateSchema,
}).superRefine((j, c) => {
  if (j.discovery.scope.channel !== "swanson" || (j.familyDiscovery
      ? j.discovery.entry.kind !== "product" || j.discovery.entry.variantId === null || j.familyDiscovery.entry.kind !== "family" || j.familyDiscovery.scope.channel !== "swanson"
      : j.discovery.entry.kind !== "family" || j.discovery.entry.variantId !== null) ||
    !j.resources.activities.browserSession || j.resources.activities.captureSwansonProduct || j.resources.activities.acquireSwansonFile)
    c.addIssue({ code: "custom", message: "Exclusive Swanson family browser phase required" });
});
export type SwansonProductJob = z.infer<typeof SwansonProductJobSchema>;
export const SwansonProductCaptureSchema = z.strictObject({ job: SwansonProductJobSchema, sourcePlan: ChannelPlanInputSchema });
export const SwansonProductHandoffSchema = z.strictObject({ job: SwansonProductJobSchema, input: ChannelSavedLabelWorkflowInputSchema });
