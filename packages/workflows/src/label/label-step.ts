import type { ChannelPlanInput, ChannelPlanOutcome } from "@crawl-automation/v3-contracts";
import type { PipelineActivities, ProductPipelineInput } from "../pipeline-model.js";

export interface LabelStep {
  input: ProductPipelineInput;
  pipeline: PipelineActivities;
  sourcePlan: ChannelPlanInput;
  manifest: Extract<ChannelPlanOutcome, { status: "prepared" }>["manifest"];
}
