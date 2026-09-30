import { isDeepStrictEqual } from "node:util";
import {
  ChannelPlanInputSchema,
  ChannelPlanOutcomeSchema,
  ChannelProductPlanSchema,
  FileAcquireInputSchema,
  type ChannelPlanInput,
  type ChannelPlanOutcome,
  type ChannelProductPlan,
} from "@crawl-automation/v3-contracts";
import { channelErrors } from "../errors.js";
import type { ChannelRegistry } from "../registry.js";
import {
  FRAGMENT_LIMIT,
  PLAN_LIMIT,
  SOURCE_LIMIT,
  decodeJson,
  encodeJson,
  planFingerprint,
  planKey,
} from "./plan-codec.js";
import { planErrors } from "./plan-errors.js";
import type {
  PlanIntegrity,
  PlanPublication,
  PlanReviews,
  PlanSourceResolver,
} from "./plan-ports.js";
import { PlanReviewLedger, planFailureCode } from "./plan-reviews.js";
import { buildPlan } from "./plan-sources.js";

export interface ProductPlansDeps {
  registry: ChannelRegistry;
  publication: PlanPublication;
  resolver: PlanSourceResolver;
  reviews: PlanReviews;
  integrity: PlanIntegrity;
}

/**
 * The formula planner, one for every channel: compiles one retained page projection into independent page and file
 * tasks. The channel's planning hook reads its projection; the text-facts-first rule decides the sources. No crawler,
 * OCR or model call.
 */
export class ProductPlans {
  private readonly ledger: PlanReviewLedger;

  constructor(private readonly deps: ProductPlansDeps) {
    this.ledger = new PlanReviewLedger(deps.reviews, deps.publication);
  }

  async run(raw: unknown, signal: AbortSignal): Promise<ChannelPlanOutcome> {
    const input = ChannelPlanInputSchema.parse(raw);
    const prior = await this.ledger.prior(input);
    if (prior) {
      return prior; // passive Reviews are never replayed
    }
    try {
      signal.throwIfAborted();
      return await this.publishOnce(input, signal);
    } catch (error) {
      const complete = await this.completedDespite(input, signal);
      if (complete) {
        return complete;
      }
      return this.ledger.record(input, planFailureCode(error, signal.aborted));
    }
  }

  /** The saved plan, checked against a fresh derivation and with its fragment and source still in R2. */
  async inspect(raw: unknown, signal: AbortSignal): Promise<ChannelProductPlan | null> {
    const input = ChannelPlanInputSchema.parse(raw);
    const saved = await this.deps.publication.remote.read(planKey(input), PLAN_LIMIT, signal);
    if (!saved) {
      return null;
    }
    const { plan } = await this.derive(input, signal);
    if (!isDeepStrictEqual(ChannelProductPlanSchema.parse(decodeJson(saved)), plan)) {
      throw planErrors.create("CHANNEL.PLAN_CONFLICT");
    }
    const checks = await Promise.allSettled([
      this.checkFragment(plan, signal),
      this.checkSource(input, signal),
    ]);
    const failed = checks.find((check) => check.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
    return plan;
  }

  /** The URL of one planned image download; only a task of the exact saved plan can obtain it. */
  async fileSource(input: ChannelPlanInput, raw: unknown, signal: AbortSignal): Promise<string> {
    const requested = FileAcquireInputSchema.parse(raw);
    const plan = await this.inspect(input, signal);
    const planned = plan?.manifest.sources.some(
      (source) => source.kind === "file-image" && isDeepStrictEqual(source.plan.acquire, requested),
    );
    const file = planned
      ? plan?.files.find((entry) => entry.resourceId === requested.resourceId)
      : null;
    if (!file) {
      throw planErrors.create("SOURCE.SESSION_MISMATCH");
    }
    return file.url;
  }

  private async publishOnce(input: ChannelPlanInput, signal: AbortSignal) {
    const old = await this.inspect(input, signal);
    if (old) {
      return this.prepared(old);
    }
    const { plan, bytes } = await this.derive(input, signal);
    const encoded = encodeJson(plan);
    const retain = AbortSignal.timeout(10_000);
    const { publication } = this.deps;
    if (plan.fragment) {
      await publication.retain(plan.fragment.objectKey, bytes, "text/html", retain);
    }
    await publication.retain(planKey(input), encoded, "application/json", retain);
    await this.checkSource(input, signal);
    if (plan.fragment) {
      await publication.publish(plan.fragment.objectKey, bytes, "text/html", signal);
    }
    await publication.publish(planKey(input), encoded, "application/json", signal);
    const confirmed = await this.inspect(input, signal);
    if (!confirmed) {
      throw planErrors.create("CHANNEL.NOT_DURABLE");
    }
    return this.prepared(confirmed);
  }

  /** A lost acknowledgement must not turn an already verified plan into a false failure. */
  private async completedDespite(input: ChannelPlanInput, signal: AbortSignal) {
    if (signal.aborted) {
      return null;
    }
    // Read-only check; if it cannot confirm the plan, the original failure is what gets recorded.
    const plan = await this.inspect(input, AbortSignal.timeout(10_000)).catch(() => null);
    return plan ? this.prepared(plan) : null;
  }

  private async derive(input: ChannelPlanInput, signal: AbortSignal) {
    const planning = this.deps.registry.get(input.channel).planning;
    if (!planning) {
      throw channelErrors.create("CHANNEL.PLANNING_UNSUPPORTED");
    }
    const source = await this.deps.resolver.resolve(input.source, input.owner, signal);
    if (!isDeepStrictEqual(source.ref, input.source)) {
      throw planErrors.create("CHANNEL.SOURCE_CONFLICT");
    }
    this.deps.integrity.verifyBytes(input.source, source.bytes, SOURCE_LIMIT);
    const product = planning.read(decodeJson(source.bytes), input.expectedUrl, input.owner);
    return buildPlan(input, product);
  }

  private async checkFragment(plan: ChannelProductPlan, signal: AbortSignal) {
    if (!plan.fragment) {
      return;
    }
    const { objectKey, byteSize } = plan.fragment;
    const bytes = await this.deps.publication.remote.read(objectKey, byteSize, signal);
    if (!bytes) {
      throw planErrors.create("CHANNEL.NOT_DURABLE");
    }
    this.deps.integrity.verifyBytes(plan.fragment, bytes, FRAGMENT_LIMIT);
  }

  /** A plan is only durable if its original input is available beyond this worker's local disk. */
  private async checkSource(input: ChannelPlanInput, signal: AbortSignal) {
    const { objectKey, byteSize } = input.source;
    const bytes = await this.deps.publication.remote.read(objectKey, byteSize, signal);
    if (!bytes) {
      throw planErrors.create("CHANNEL.NOT_DURABLE");
    }
    this.deps.integrity.verifyBytes(input.source, bytes, SOURCE_LIMIT);
  }

  private prepared(plan: ChannelProductPlan): ChannelPlanOutcome {
    return ChannelPlanOutcomeSchema.parse({
      status: "prepared",
      operationId: plan.input.operationId,
      inputFingerprint: planFingerprint(plan.input),
      evidenceKey: planKey(plan.input),
      manifest: plan.manifest,
    });
  }
}
