import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { sha256 } from "@crawl-automation/platform";
import {
  ChannelLabelInputSchema,
  ChannelSavedLabelWorkflowInputSchema,
  type ChannelPlanInput,
  type ResourceGate,
} from "@crawl-automation/v3-contracts";
import type { LabelWorkflowInput, ProductPipelineInput } from "@crawl-automation/workflows";
import type { z } from "zod";
import { appErrors } from "../errors.js";
import type { EvidencePublisher, ExecutionRef, ExecutionRegistry, PlanReader } from "./ports.js";

type LabelInput = z.infer<typeof ChannelLabelInputSchema>;
export type LabelHandoff = z.infer<typeof ChannelSavedLabelWorkflowInputSchema>;

/** The shared Label workflow's queues and permits, from the worker's config. */
export interface SharedLabelSettings {
  queues: LabelWorkflowInput["queues"];
  resources?: ResourceGate | undefined;
}

/** The label workflow's model settings, task queues and permits, from the worker's config. */
export interface LabelSettings {
  text: LabelInput["text"];
  visionConfigFingerprint: string;
  evidencePolicy: LabelInput["evidencePolicy"];
  queues: LabelHandoff["queues"];
  resources: ResourceGate;
  /** The shared Label workflow's queues and permits (`LabelTasks`); absent, only the earlier workflow is built. */
  shared?: SharedLabelSettings | undefined;
}

export interface LabelHandoffDeps {
  registry: ChannelRegistry;
  plans: PlanReader;
  evidence: EvidencePublisher;
  executions: ExecutionRegistry;
  settings: LabelSettings;
}

export interface HandoffRequest {
  pipeline: ProductPipelineInput;
  sourcePlan: ChannelPlanInput;
  execution: ExecutionRef;
}

/**
 * Builds the existing label workflow's input for one planned product, keeps it as evidence, and links the
 * observation to the pipeline run.
 */
export class LabelHandoffs {
  constructor(private readonly deps: LabelHandoffDeps) {}

  async prepare(request: HandoffRequest, signal: AbortSignal): Promise<LabelHandoff> {
    const { pipeline, sourcePlan } = request;
    if (!(await this.deps.plans.inspect(sourcePlan, signal))) {
      throw appErrors.create("PIPELINE.PLAN_UNVERIFIED", {
        details: { operationId: sourcePlan.operationId },
      });
    }
    const handoff = ChannelSavedLabelWorkflowInputSchema.parse({
      input: this.labelInput(pipeline, sourcePlan),
      queues: this.deps.settings.queues,
      resources: this.deps.settings.resources,
    });
    const key = `v3/product-runs/${pipeline.operationId}/label.json`;
    const bytes = Buffer.from(JSON.stringify(handoff));
    await this.deps.evidence.publish(key, bytes, "application/json", signal);
    await this.deps.executions.register(sourcePlan.owner.observationId, request.execution);
    return handoff;
  }

  private labelInput(pipeline: ProductPipelineInput, sourcePlan: ChannelPlanInput): LabelInput {
    const { text, visionConfigFingerprint, evidencePolicy } = this.deps.settings;
    const corePolicy = this.deps.registry.get(pipeline.channel).planning?.corePolicy;
    const identity = Buffer.from(JSON.stringify([pipeline.operationId, sourcePlan.operationId]));
    return ChannelLabelInputSchema.parse({
      operationId: `label-${sha256(identity)}`,
      sourcePlan,
      text,
      visionConfigFingerprint,
      evidencePolicy,
      ...(corePolicy ? { corePolicy } : {}),
    });
  }
}
