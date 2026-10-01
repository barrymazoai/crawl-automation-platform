import { mergeLabelProduct } from "../assembly/label-merge.js";
import { labelFailure } from "./label-errors.js";
import { labelKeys } from "./label-plan-model.js";
import type { LabelPlans, LoadedPlan } from "./label-plans.js";
import { orderedEvidence, type OrderedDeps } from "./ordered-evidence.js";
import {
  OrderedProgressSchema,
  OrderedSelectionSchema,
  type OrderedEvidence,
  type OrderedProgress,
} from "./ordered-model.js";

/** The configured source order; URL hints rank images, never establish their label contents. */
export function orderedSources(loaded: LoadedPlan) {
  const { policy, preparation } = orderedPolicy(loaded);
  const pages = loaded.manifest.sources.filter((source) => source.kind === "page");
  const images = loaded.manifest.sources.filter((source) => source.kind === "file-image");
  if (loaded.manifest.sources.length !== pages.length + images.length) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  const order = loaded.imageOrder ?? [];
  if (
    new Set(order).size !== images.length ||
    order.length !== images.length ||
    images.some((source) => !order.includes(source.id))
  ) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  const pageIds = preparation.pageHasLabelSection ? pages.map((page) => page.id) : [];
  return policy.order === "images-first" ? [...order, ...pageIds] : [...pageIds, ...order];
}

function orderedPolicy(loaded: LoadedPlan) {
  const policy = loaded.input.sourcePolicy;
  const preparation = loaded.labelPreparation;
  if (!policy || !preparation || loaded.input.evidencePolicy !== "label-image-first/6") {
    throw labelFailure("CHANNEL.LABEL_SELECTION_UNAVAILABLE");
  }
  return { policy, preparation };
}

/** Read-only completeness checks use the actual /6 merger, including split panels and conflicts. */
export class LabelOrderedSelection {
  constructor(
    private readonly plans: LabelPlans,
    private readonly deps: OrderedDeps,
  ) {}

  async inspect(raw: unknown, signal: AbortSignal) {
    const request = OrderedProgressSchema.parse(raw);
    const loaded = await this.plans.load(request.input, signal);
    assertPrefix(
      orderedSources(loaded),
      request.states.map((state) => state.id),
    );
    const evidence = await orderedEvidence(this.plans, this.deps, { request, signal });
    return { input: request, ...progress(request, evidence) };
  }

  /** Omitted downloads are legal only after the attempted prefix proves a complete label. */
  async manifest(raw: unknown, signal: AbortSignal) {
    const selection = OrderedSelectionSchema.parse(raw);
    const loaded = await this.plans.load(selection.input, signal);
    const attempted = selection.states.filter((state) => state.status !== "not_started");
    const request = { input: selection.input, states: attempted };
    assertCoverage(loaded, selection.states);
    assertPrefix(
      orderedSources(loaded),
      attempted.map((state) => state.id),
    );
    const evidence = await orderedEvidence(this.plans, this.deps, { request, signal });
    if (!progress(request, evidence).complete) {
      throw labelFailure("CHANNEL.LABEL_SELECTION_UNVERIFIED");
    }
    const selected = new Set(evidence.sources.map((source) => source.id));
    const skipped = selection.states
      .filter((state) => !selected.has(state.id))
      .map((state) => state.id);
    const decisions = decisionsFor(loaded, selection.states, selected);
    await this.plans.publish(
      labelKeys.selection(selection.input),
      { request: selection, decisions },
      signal,
    );
    const documents = selection.input.admission
      ? await this.plans.fullDocuments(loaded.manifest, signal)
      : [];
    return this.plans.publishManifest(
      { input: selection.input, sources: evidence.sources, skipped, documents },
      signal,
    );
  }
}

function progress(request: OrderedProgress, evidence: OrderedEvidence) {
  const base = { complete: false, terminal: evidence.terminal };
  const reasons = [...evidence.reasons];
  if (evidence.sources.length) {
    const manifest = {
      operationId: request.input.operationId,
      observation: request.input.owner,
      evidencePolicy: request.input.evidencePolicy,
      sources: evidence.sources,
    };
    const merged = mergeLabelProduct(manifest, evidence);
    const candidates = evidence.entries.map((entry) => entry.candidate);
    base.complete =
      !base.terminal &&
      merged.status === "ready" &&
      candidates.some((candidate) => candidate.formulaComplete) &&
      candidates.some((candidate) => candidate.ingredientsComplete);
    for (const entry of evidence.entries) {
      const rank = candidateProgress(entry.candidate);
      const code = merged.codes[0];
      if (code) {
        reasons.push({
          progress: rank,
          failure: {
            sourceId: entry.id,
            code,
            executionFact: "executed",
          },
        });
      }
    }
  }
  const reason = reasons.sort((left, right) => right.progress - left.progress)[0]?.failure;
  return { ...base, ...(reason ? { reason } : {}) };
}

function candidateProgress(candidate: OrderedEvidence["entries"][number]["candidate"]) {
  return candidate.formula ? 4 : candidate.otherIngredients ? 3 : 2;
}

function assertPrefix(order: string[], attempted: string[]) {
  if (attempted.length > order.length || attempted.some((id, index) => id !== order[index])) {
    throw labelFailure("CHANNEL.LABEL_SELECTION_UNVERIFIED");
  }
}

function assertCoverage(loaded: LoadedPlan, states: { id: string }[]) {
  const ids = new Set(states.map((state) => state.id));
  if (
    ids.size !== states.length ||
    ids.size !== loaded.manifest.sources.length ||
    loaded.manifest.sources.some((source) => !ids.has(source.id))
  ) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
}

function decisionsFor(
  loaded: LoadedPlan,
  states: { id: string; status: string }[],
  selected: Set<string>,
) {
  const eligible = new Set(orderedSources(loaded));
  return states.map((state) => ({
    id: state.id,
    action: selected.has(state.id) ? "selected" : "skipped",
    reason: selected.has(state.id)
      ? "verified_label_source"
      : !eligible.has(state.id)
        ? "no_label_section"
        : state.status === "not_started"
          ? "complete_label_already_selected"
          : state.status,
  }));
}
