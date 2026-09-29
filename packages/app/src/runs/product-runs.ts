import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import type { ProductPipelineInput } from "@crawl-automation/workflows";
import type { Channel } from "../delivery/delivery-coordinator.js";
import { appErrors } from "../errors.js";
import type { ProductRun } from "./run-model.js";

export interface ProductSource {
  brandId: string;
  channel: Channel;
}

export interface AcceptedProductRun {
  runId: string;
  workflowId: string;
  channel: Channel;
  brandId: string;
  sourceId: string;
  url: string;
  /** Temporal's run ID once the workflow was started; null before. */
  startedRunId: string | null;
}

export interface ProductRunStore {
  source(sourceId: string): Promise<ProductSource | null>;
  /** Accepts the run once; repeating the same request returns it, a different one under its ID is refused. */
  accept(run: ProductRun & ProductSource): Promise<AcceptedProductRun>;
  markStarted(runId: string, startedRunId: string): Promise<void>;
}

export interface PipelineStarter {
  /** Starts the product workflow once; when it already exists, returns the existing run's ID. */
  start(workflowId: string, input: ProductPipelineInput): Promise<{ startedRunId: string }>;
}

/** Where product workflows run, and the permits each channel's capture takes. */
export interface PipelineTargets {
  queues: ProductPipelineInput["queues"];
  channels: Partial<Record<Channel, { resources: ResourceGate }>>;
}

export interface ProductRunDeps {
  store: ProductRunStore;
  starter: PipelineStarter;
  registry: ChannelRegistry;
  targets: PipelineTargets;
}

/** Accepts a product run and starts its workflow; a repeated request only finishes what the first began. */
export class ProductRuns {
  constructor(private readonly deps: ProductRunDeps) {}

  async submit(run: ProductRun): Promise<string> {
    const source = await this.deps.store.source(run.sourceId);
    if (!source) {
      throw appErrors.create("RUN.SOURCE_NOT_FOUND", { details: { sourceId: run.sourceId } });
    }
    const target = this.deps.targets.channels[source.channel];
    if (!target) {
      throw appErrors.create("RUN.CHANNEL_UNSUPPORTED", { details: { channel: source.channel } });
    }
    // Refuses a page of another site before anything is stored.
    this.deps.registry.get(source.channel).productAddress(run.url);
    const accepted = await this.deps.store.accept({ ...run, ...source });
    if (accepted.startedRunId === null) {
      const input = this.pipelineInput(accepted, target.resources);
      const { startedRunId } = await this.deps.starter.start(accepted.workflowId, input);
      await this.deps.store.markStarted(accepted.runId, startedRunId);
    }
    return accepted.runId;
  }

  private pipelineInput(run: AcceptedProductRun, resources: ResourceGate): ProductPipelineInput {
    return {
      codec: "product-pipeline/1",
      runId: run.runId,
      channel: run.channel,
      url: run.url,
      brandId: run.brandId,
      sourceId: run.sourceId,
      operationId: `product-${run.runId}`,
      queues: this.deps.targets.queues,
      resources,
    };
  }
}
