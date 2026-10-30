import {
  DtcProductScope,
  REVIEW_SCOPE,
  dtcAgentErrors,
  reviewScopeOutcome,
} from "@crawl-automation/channel-dtc";
import { ArtifactResolver, measuredMethod } from "@crawl-automation/platform";
import { CodexTextModel } from "@crawl-automation/processing";
import { ChannelPlanInputSchema, type ChannelPlanInput } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";
import { textModelRoute } from "./text-model-route.js";

const ReviewScopeRequestSchema = z.strictObject({
  sourcePlan: ChannelPlanInputSchema,
  operationId: z.string().min(1).max(200),
  reviewCode: z.string().min(1).max(200).nullable(),
});

const unresolved = (reason: string) =>
  dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED", { details: { reason } });

/** Routing needs no model client: the step shares the label text model's queue and resources. */
export function dtcReviewScopePipelineActivities(parts: WorkerParts) {
  return {
    prepareDtcReviewScope: guarded(
      "prepareDtcReviewScope",
      async () => {
        const route = textModelRoute(parts, "reviewDtcProductScope");
        if (!route) {
          throw unresolved("text_model_settings_missing");
        }
        return route;
      },
      parts.log,
    ),
  };
}

/**
 * Owner 2026-10-30: a DTC label Review asks once, from the retained page, whether the offer is a supplement, a bundle
 * or neither. The answer and its citations stay under v3/dtc-review-scope; a single product keeps its Review.
 */
export function dtcReviewScopeModelActivities(parts: WorkerParts) {
  return {
    reviewDtcProductScope: guarded(
      "reviewDtcProductScope",
      (raw, signal) => reviewScope(parts, ReviewScopeRequestSchema.parse(raw), signal),
      parts.log,
    ),
  };
}

async function reviewScope(
  parts: WorkerParts,
  request: z.infer<typeof ReviewScopeRequestSchema>,
  signal: AbortSignal,
) {
  const { sourcePlan, operationId, reviewCode } = request;
  const config = parts.config.processing?.codex?.text;
  if (sourcePlan.channel !== "dtc" || !config) {
    throw unresolved(config ? "not_dtc" : "text_model_settings_missing");
  }
  const evidence = await planEvidence(parts, sourcePlan, signal);
  const model = measuredMethod(await CodexTextModel.open(config, process.env), "interpret", {
    kind: "model-text",
    step: "dtc-review-scope",
    providerCall: true,
    cacheHit: false,
  });
  try {
    const scope = await new DtcProductScope(
      parts.publication,
      (call, active) => model.interpret({ operationId, ...call }, active),
      REVIEW_SCOPE,
    ).review(scopeInput(sourcePlan, operationId, evidence), signal);
    const { listingId, variantId } = sourcePlan.owner;
    const identity = { listingId, variantId };
    return (
      reviewScopeOutcome({ scope, operationId, identity, reviewCode }) ?? {
        status: "kept",
        kind: scope.decision.kind,
      }
    );
  } finally {
    await model.close();
  }
}

/** The page's own title, brand, description and website variants, as the agent's scope question reads them. */
function scopeInput(
  plan: ChannelPlanInput,
  operationId: string,
  evidence: Awaited<ReturnType<typeof planEvidence>>,
) {
  return {
    operationId,
    url: plan.expectedUrl,
    source: plan.source,
    fields: {
      title: evidence.title,
      brand: evidence.brandRaw,
      ...(evidence.detailsHtml ? { html: evidence.detailsHtml } : {}),
    },
    variants: evidence.variants,
  };
}

/** The captured product through the channel's own projection decoder, with verified artifact ownership. */
async function planEvidence(parts: WorkerParts, plan: ChannelPlanInput, signal: AbortSignal) {
  const saved = await new ArtifactResolver(parts.copies, parts.r2.store).resolve(
    plan.source,
    plan.owner,
    signal,
  );
  const planning = parts.registry.get("dtc").planning;
  if (!planning) {
    throw unresolved("dtc_planning_missing");
  }
  return planning.read(
    JSON.parse(Buffer.from(saved.bytes).toString()),
    plan.expectedUrl,
    plan.owner,
  ).evidence;
}
