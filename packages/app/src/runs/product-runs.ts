import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import type { ProductPipelineInput } from "@crawl-automation/workflows";
import type { Channel } from "../delivery/delivery-coordinator.js";
import { appErrors } from "../errors.js";
import type { ProductRun } from "./run-model.js";
import type { BrandScanStore } from "../brand-scans/ports.js";

/** A product run's workflow ID (the product_run table checks the same rule). */
export const productRunWorkflowId = (runId: string) => `product-run-${runId}`;

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
  sources: Pick<BrandScanStore, "sources">;
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
    const sourceUrl = await this.sourceUrl(run.sourceId, source);
    this.deps.registry.forBrandSource(source.channel, sourceUrl).productAddress(run.url);
    const accepted = await this.deps.store.accept({ ...run, ...source });
    if (accepted.startedRunId === null) {
      const input = this.pipelineInput(accepted, target.resources, sourceUrl);
      const { startedRunId } = await this.deps.starter.start(accepted.workflowId, input);
      await this.deps.store.markStarted(accepted.runId, startedRunId);
    }
    return accepted.runId;
  }

  private async sourceUrl(sourceId: string, product: ProductSource): Promise<string | undefined> {
    if (product.channel !== "dtc") {
      return undefined;
    }
    const sources = await this.deps.sources.sources([sourceId]);
    const source = sources.find((entry) => entry.sourceId === sourceId);
    if (!source || source.channel !== product.channel || source.brandId !== product.brandId) {
      throw appErrors.create("RUN.SOURCE_NOT_FOUND", { details: { sourceId } });
    }
    return source.url;
  }

  private pipelineInput(
    run: AcceptedProductRun,
    resources: ResourceGate,
    sourceUrl?: string,
  ): ProductPipelineInput {
    return {
      codec: "product-pipeline/1",
      runId: run.runId,
      channel: run.channel,
      capture: this.deps.registry.forBrandSource(run.channel, sourceUrl).captureModes[0],
      url: run.url,
      brandId: run.brandId,
      sourceId: run.sourceId,
      ...(sourceUrl ? { sourceUrl } : {}),
      operationId: `product-${run.runId}`,
      queues: this.deps.targets.queues,
      resources,
    };
  }
}
