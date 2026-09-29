import {
  AcquisitionReviewSchema,
  LabelProductJoinSchema,
  ProductImageOutcomeSchema,
  ProductWorkflowOutcomeSchema,
} from "@crawl-automation/v3-contracts";
import { ApplicationFailure, isCancellation } from "@temporalio/workflow";
import type { LabelRun } from "./label-run.js";
import type { Issued } from "./label-source.js";
import { ManifestResultSchema, type ManifestResult, type State } from "./label-model.js";
import type { Walk } from "./label-image-first.js";
import { sameJson } from "./same.js";

type ReviewCode = "CHANNEL.LABEL_PREPARATION_UNVERIFIED" | "CHANNEL.DEPENDENCY_UNAVAILABLE";
type Failure = { sourceId: string; code: string; executionFact: string };

const identityConflict = () =>
  ApplicationFailure.nonRetryable(
    "Label source identity conflict",
    "CHANNEL.LABEL_IDENTITY_CONFLICT",
  );

/** The product's own label Review, with every source's state and, when known, what held each one up. */
export async function reviewLabel(
  run: LabelRun,
  at: { states: unknown[]; code: ReviewCode; failures?: Failure[] },
): Promise<unknown> {
  const { input } = run.entry;
  const request = {
    input,
    states: at.states,
    code: at.code,
    ...(at.failures ? { failures: at.failures } : {}),
  };
  const review = AcquisitionReviewSchema.parse(
    await run.call("activities", "reviewLabelProduct", request),
  );
  if (review.operationId !== input.operationId || review.code !== at.code) {
    throw identityConflict();
  }
  return review;
}

/** Sources held up by permits: those never started (waiting) or perhaps still running (quarantined). */
export function permitFailures(run: LabelRun): Failure[] {
  return [
    ...[...run.waiting].sort().map((sourceId) => ({
      sourceId,
      code: "RESOURCE.WAIT_LIMIT",
      executionFact: "not_executed",
    })),
    ...[...run.quarantined].sort().map((sourceId) => ({
      sourceId,
      code: "RESOURCE.OWNER_QUARANTINED",
      executionFact: "unknown",
    })),
  ];
}

/** The label manifest; a failure keeps the manifest step's own code with the Review. */
export async function labelManifest(
  run: LabelRun,
  walk: Walk | null,
): Promise<{ kind: "manifest"; result: ManifestResult } | { kind: "review"; review: unknown }> {
  const { input } = run.entry;
  const request = walk
    ? { input, states: [...walk.states, ...walk.notStarted], selectedImageId: walk.selectedImageId }
    : input;
  const name = walk ? "prepareSingleLabelManifest" : "prepareLabelManifest";
  try {
    return {
      kind: "manifest",
      result: ManifestResultSchema.parse(await run.call("activities", name, request)),
    };
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    const cause = causeCode(error);
    const failures = cause
      ? [{ sourceId: "manifest", code: cause, executionFact: "executed" }]
      : undefined;
    const states = walk ? walk.states : [];
    const code = "CHANNEL.LABEL_PREPARATION_UNVERIFIED";
    return {
      kind: "review",
      review: await reviewLabel(run, { states, code, ...(failures ? { failures } : {}) }),
    };
  }
}

/** The first coded cause in an activity failure's chain. */
function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if (current instanceof ApplicationFailure && /^[A-Z]+\.[A-Z_]+$/.test(current.type ?? "")) {
      return current.type ?? undefined;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The manifest names exactly this task's sources, each either selected or skipped, and the tasks issued here. */
export function assertManifest(
  run: LabelRun,
  at: { result: ManifestResult; all: { id: string }[]; issued: Issued },
): void {
  const { result, all, issued } = at;
  const { input } = run.entry;
  const { manifest } = result;
  const selected = new Set(manifest.sources.map((source) => source.id));
  const skipped = new Set(result.skipped);
  const identity =
    sameJson(result.input, input) &&
    sameJson(manifest.observation, input.owner) &&
    manifest.operationId === input.operationId &&
    manifest.evidencePolicy === input.evidencePolicy;
  const covered =
    skipped.size === result.skipped.length &&
    ![...skipped].some((id) => selected.has(id)) &&
    selected.size + skipped.size === all.length &&
    all.every((state) => selected.has(state.id) || skipped.has(state.id));
  const issuedSame = manifest.sources.every(
    (source) => !issued.has(source.id) || sameJson(issued.get(source.id), source),
  );
  if (!identity || !covered || !issuedSame) {
    throw identityConflict();
  }
}

/** Assembly, then collection: the formula is saved once, from the published assembly. */
export async function finishLabel(
  run: LabelRun,
  join: { manifest: ManifestResult["manifest"]; states: State[] },
): Promise<unknown> {
  const parsed = LabelProductJoinSchema.parse(join);
  const assembled = ProductImageOutcomeSchema.safeParse(
    await run.call("activities", "assembleLabelProduct", parsed),
  );
  if (!assembled.success) {
    throw ApplicationFailure.nonRetryable("Invalid label receipt", "LABEL_PRODUCT.RECEIPT_INVALID");
  }
  const key = `v3/label-products/${parsed.manifest.operationId}/assembly.json`;
  if (assembled.data.evidenceKey !== key) {
    throw ApplicationFailure.nonRetryable("Wrong label receipt", "LABEL_PRODUCT.IDENTITY_CONFLICT");
  }
  if (assembled.data.status === "review") {
    return assembled.data;
  }
  const saved = ProductWorkflowOutcomeSchema.safeParse(
    await run.call("activities", "collectLabelProduct", { join: parsed, evidenceKey: key }),
  );
  const own =
    saved.success &&
    saved.data.evidenceKey === key &&
    (saved.data.status !== "collected" ||
      (saved.data.operationId === parsed.manifest.operationId &&
        saved.data.observationId === parsed.manifest.observation.observationId));
  if (!own || !saved.success) {
    throw ApplicationFailure.nonRetryable(
      "Invalid label collection",
      "LABEL_PRODUCT.IDENTITY_CONFLICT",
    );
  }
  return saved.data;
}
