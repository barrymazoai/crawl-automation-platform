import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { LabelPlanInputSchema } from "@crawl-automation/processing";
import { sha256 } from "@crawl-automation/v3-artifacts";
import type { ChannelPlanInput } from "@crawl-automation/v3-contracts";
import {
  LabelWorkflowInputSchema,
  type LabelWorkflowInput,
  type ProductPipelineInput,
} from "@crawl-automation/workflows";
import { appErrors } from "../errors.js";
import type { HandoffRequest, LabelSettings, SharedLabelSettings } from "./label-handoffs.js";
import type { EvidencePublisher, ExecutionRegistry, PlanReader } from "./ports.js";

export type { SharedLabelSettings };

export interface LabelTaskDeps {
  registry: ChannelRegistry;
  plans: PlanReader;
  evidence: EvidencePublisher;
  executions: ExecutionRegistry;
  settings: LabelSettings;
}

/**
 * The shared Label workflow's input for one planned product, for every channel: the channel's plan becomes the
 * label task's plan, with the text and vision setups and the channel's label-core policy. It is kept as evidence
 * and the observation is linked to the pipeline run.
 */
export class LabelTasks {
  constructor(private readonly deps: LabelTaskDeps) {}

  async prepare(request: HandoffRequest, signal: AbortSignal): Promise<LabelWorkflowInput> {
    const { pipeline, sourcePlan } = request;
    const shared = this.deps.settings.shared;
    if (!shared) {
      throw appErrors.create("PIPELINE.LABEL_SETTINGS_MISSING");
    }
    if (!(await this.deps.plans.inspect(sourcePlan, signal))) {
      throw appErrors.create("PIPELINE.PLAN_UNVERIFIED", {
        details: { operationId: sourcePlan.operationId },
      });
    }
    const task = LabelWorkflowInputSchema.parse({
      input: this.labelTask(pipeline, sourcePlan),
      queues: shared.queues,
      ...(shared.resources ? { resources: shared.resources } : {}),
    });
    const key = `v3/product-runs/${pipeline.operationId}/label-task.json`;
    await this.deps.evidence.publish(
      key,
      Buffer.from(JSON.stringify(task)),
      "application/json",
      signal,
    );
    await this.deps.executions.register(sourcePlan.owner.observationId, request.execution);
    return task;
  }

  private labelTask(pipeline: ProductPipelineInput, sourcePlan: ChannelPlanInput) {
    const { text, visionConfigFingerprint, evidencePolicy } = this.deps.settings;
    const corePolicy = this.deps.registry.get(pipeline.channel).planning?.corePolicy;
    const identity = Buffer.from(JSON.stringify([pipeline.operationId, sourcePlan.operationId]));
    return LabelPlanInputSchema.parse({
      operationId: `label-${sha256(identity)}`,
      owner: sourcePlan.owner,
      plan: {
        operationId: sourcePlan.operationId,
        sourceOperationId: sourcePlan.source.producer.operationId,
        input: sourcePlan,
      },
      text,
      visionConfigFingerprint,
      ...(evidencePolicy ? { evidencePolicy } : {}),
      ...(corePolicy ? { corePolicy } : {}),
    });
  }
}
