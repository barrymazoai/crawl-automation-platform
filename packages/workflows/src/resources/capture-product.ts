import { proxyActivities } from "@temporalio/workflow";
import { once } from "../activity-options.js";
import {
  CaptureResultSchema,
  type PipelineActivities,
  type ProductPipelineInput,
} from "../pipeline-model.js";
import { versionedResourceGate } from "./versioned-gate.js";

/** Capture uses the permit as its activity identity and acknowledges cancellation before releasing. */
export async function captureProduct(input: ProductPipelineInput, pipeline: PipelineActivities) {
  const gate = versionedResourceGate(input.resources, { ignoreLegacyBinding: true });
  return CaptureResultSchema.parse(
    await gate("captureProduct", (binding) => {
      const capture = binding
        ? proxyActivities<PipelineActivities>({
            taskQueue: input.queues.activities,
            ...once,
            ...binding,
          })
        : pipeline;
      return capture.captureProduct(input);
    }),
  );
}
