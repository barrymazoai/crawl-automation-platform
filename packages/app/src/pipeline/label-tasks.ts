import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { LabelPlanInputSchema } from "@crawl-automation/processing";
import { sha256 } from "@crawl-automation/platform";
import type { ChannelPlanInput, ResourceGate } from "@crawl-automation/v3-contracts";
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
      ...(shared.resources ? { resources: labelGates(shared.resources) } : {}),
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
    // Legacy /5 drops page preparation after a complete image. Packaging needs that document.
    const policy =
      sourcePlan.sourcePolicy || evidencePolicy === "label-image-first/5"
        ? "label-image-first/7"
        : evidencePolicy;
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
      admission: "label-packaging/1",
      // Owner 2026-10-08: every channel reports a source's real failure ahead of "no label" on another source.
      failurePolicy: "source-failure-first/1",
      ...(policy ? { evidencePolicy: policy } : {}),
      ...(sourcePlan.sourcePolicy ? { sourcePolicy: sourcePlan.sourcePolicy } : {}),
      ...(corePolicy ? { corePolicy } : {}),
    });
  }
}

/**
 * The Label workflow's permits: every gated label call (OCR API, Codex text or vision) is one request whose Review
 * receipt already means nothing runs outside it, so a Review releases its permit at once (`releaseOnReview`). There is
 * no review-stop check: the new worker does not host the old review-stop verifier, and requiring one would hold
 * every Reviewed call's permit as "stop unverified".
 */
function labelGates(resources: ResourceGate): ResourceGate {
  const { reviewStopCheck: _unused, ...gates } = resources;
  return { ...gates, releaseOnReview: true };
}
