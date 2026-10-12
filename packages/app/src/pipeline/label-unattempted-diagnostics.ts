import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { recordRecovery } from "@crawl-automation/platform";
import { safeDiagnosticText } from "@crawl-automation/platform/errors/summary";
import type { LabelPlanInput, ProductPlanReader } from "@crawl-automation/processing";
import {
  ExecutionIdSchema,
  SourceOutcomesSchema,
  type SavedEvidenceSource,
} from "@crawl-automation/v3-contracts";
import { appErrors } from "../errors.js";

const UnattemptedStatesSchema = z
  .array(z.strictObject({ id: ExecutionIdSchema, status: z.literal("not_started") }))
  .max(100);

/** This activity only reads the existing plan; it never prepares, inspects or publishes another source. */
export async function unattemptedLabelDiagnostics(
  at: { input: LabelPlanInput; states: unknown[]; code?: string; plans?: ProductPlanReader },
  signal: AbortSignal,
) {
  const states = UnattemptedStatesSchema.safeParse(at.states);
  if (!at.plans || at.code !== "CHANNEL.LABEL_NO_SOURCE" || !states.success) {
    return {};
  }
  // Diagnostics only: a failed lookup leaves the summary out and never stops the Review itself (review 2026-10-12).
  try {
    return await planSummary({ ...at, plans: at.plans, states: states.data }, signal);
  } catch (error) {
    signal.throwIfAborted();
    recordRecovery(error, { operation: "pipeline/label-unattempted-diagnostics" });
    return {};
  }
}

async function planSummary(
  at: { input: LabelPlanInput; states: { id: string }[]; plans: ProductPlanReader },
  signal: AbortSignal,
) {
  const plan = await at.plans.inspect(at.input.plan, signal);
  if (!plan) {
    return {};
  }
  const { manifest } = plan;
  assertPlanIdentity({ input: at.input, states: at.states }, manifest);
  if (
    plan.labelPreparation?.pageHasLabelSection !== false ||
    manifest.sources.some((source) => source.kind === "file-image")
  ) {
    return {};
  }
  return { sourceOutcomes: noEligibleSources(manifest.sources) };
}

function assertPlanIdentity(
  at: { input: LabelPlanInput; states: { id: string }[] },
  manifest: NonNullable<Awaited<ReturnType<ProductPlanReader["inspect"]>>>["manifest"],
) {
  const ids = new Set(at.states.map((state) => state.id));
  if (
    manifest.operationId !== at.input.plan.operationId ||
    !isDeepStrictEqual(manifest.observation, at.input.owner) ||
    ids.size !== at.states.length ||
    ids.size !== manifest.sources.length ||
    manifest.sources.some((source) => !ids.has(source.id))
  ) {
    throw appErrors.create("PIPELINE.REVIEW_UNVERIFIED");
  }
}

function noEligibleSources(sources: Pick<SavedEvidenceSource, "id" | "kind">[]) {
  const outcomes = [
    ...sources.map((source) => ({
      sourceId: safeDiagnosticText(source.id, 128) ?? "source",
      kind: source.kind === "page" ? "page" : source.kind === "pdf-text" ? "text" : "image",
      status: "not_started",
      reason: source.kind === "page" ? "skipped" : "unsupported_media",
      detail: source.kind === "page" ? "no_label_section" : safeDiagnosticText(source.kind, 240),
    })),
    // An explicit aggregate, not an invented image source or an attempted source outcome.
    { sourceId: "images", kind: "image", status: "not_started", reason: "none_eligible" },
  ];
  return SourceOutcomesSchema.parse({
    total: outcomes.length,
    omitted: Math.max(0, outcomes.length - 20),
    sources: [...outcomes.slice(0, 19), ...(outcomes.length > 19 ? outcomes.slice(-1) : [])],
  });
}
