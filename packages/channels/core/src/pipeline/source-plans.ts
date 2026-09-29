import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { ChannelPlanInputSchema, type ChannelPlanInput } from "@crawl-automation/v3-contracts";
import type { ChannelPlanning, ParsedProduct, ProductIdentity } from "../adapter.js";
import type { CaptureRequest, PlanSettings } from "./capture-request.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

interface Projected {
  request: CaptureRequest;
  identity: ProductIdentity;
  bytes: Buffer;
}

/**
 * Turns one parsed page into the formula planner's input: the channel's projection is published to R2 under the
 * capture's operation, and the plan input points at it with the observation it belongs to.
 */
export class ProductSourcePlans {
  constructor(
    private readonly publication: RetainedPublication,
    private readonly settings: PlanSettings,
  ) {}

  async publish(
    request: CaptureRequest,
    input: { parsed: ParsedProduct; planning: ChannelPlanning },
    signal: AbortSignal,
  ): Promise<ChannelPlanInput> {
    const bytes = encode(input.planning.projection(input.parsed.rendered));
    const projected = { request, identity: input.parsed.identity, bytes };
    const plan = this.planInput(projected, input.planning);
    await this.publication.publish(plan.source.objectKey, bytes, "application/json", signal);
    return plan;
  }

  private planInput(projected: Projected, planning: ChannelPlanning): ChannelPlanInput {
    const { request, identity, bytes } = projected;
    const key = sha256(encode([request.operationId, identity]));
    const owner = {
      schemaVersion: 1,
      requestId: request.runId,
      observationId: `${request.channel}-${key}`,
      brandId: request.brandId,
      sourceId: request.sourceId,
      ...identity,
    };
    const { egressId, ...providers } = this.settings;
    return ChannelPlanInputSchema.parse({
      operationId: `plan-${key}`,
      owner,
      channel: planning.channel,
      parserVersion: planning.parserVersion,
      expectedUrl: request.url,
      binding: { sessionId: request.operationId, egressId },
      ...providers,
      source: {
        schemaVersion: 1,
        artifactId: `source-${key}`,
        observationId: owner.observationId,
        sourceId: owner.sourceId,
        ...identity,
        kind: "result-json",
        mediaType: "application/json",
        objectKey: `v3/${request.channel}-products/${request.operationId}/projection.json`,
        byteSize: bytes.length,
        sha256: sha256(bytes),
        producer: {
          operationId: request.operationId,
          module: planning.projectionModule,
          implementationVersion: planning.parserVersion,
        },
      },
    });
  }
}
