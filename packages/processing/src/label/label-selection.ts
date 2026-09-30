import {
  isCompleteLabelImage,
  labelImageIntegrityCodes,
  type LabelProductManifest,
  type SavedEvidenceSource,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import {
  LabelSourceRequestSchema,
  type LabelManifestResult,
  type SourceState,
} from "./label-plan-model.js";
import type { LabelPlans } from "./label-plans.js";
import {
  assertFilesRetained,
  assertInOrder,
  finishedState,
  selectionContext,
} from "./selection-checks.js";
import type { LabelInspection, SelectionContext, SelectionOutcome } from "./selection-model.js";
import { SkipEvidence } from "./skip-evidence.js";

type Source = LabelProductManifest["sources"][number];

export type { LabelInspection, SelectionContext, SelectionOutcome } from "./selection-model.js";

const unverified = () => labelFailure("CHANNEL.LABEL_SELECTION_UNVERIFIED");

/**
 * Image-first label selection: once one image holds the complete label, the other images are skipped, each for a
 * reason that is checked against its own evidence. Every original stays required evidence.
 */
export class LabelImageSelection {
  private readonly inspection: LabelInspection;
  private readonly evidence: SkipEvidence;

  constructor(
    private readonly plans: LabelPlans,
    deps: { inspection: LabelInspection; visionFingerprint: (task: VisionTask) => string },
  ) {
    this.inspection = deps.inspection;
    this.evidence = new SkipEvidence(deps);
  }

  /** Whether one image's registered answer holds a complete, intact label. */
  async imageCheck(raw: unknown, signal: AbortSignal) {
    const request = LabelSourceRequestSchema.parse(raw);
    if (request.input.evidencePolicy !== "label-image-first/5") {
      throw labelFailure("CHANNEL.LABEL_SELECTION_UNAVAILABLE");
    }
    const result = await this.plans.source(request, signal);
    if (result.status !== "prepared" || result.source.kind !== "image") {
      throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
    }
    const candidate = await this.inspection.image(result.source, signal);
    const complete =
      isCompleteLabelImage({ kind: "image", candidate }) &&
      !labelImageIntegrityCodes(candidate).length;
    return { input: request, complete };
  }

  async manifest(raw: unknown, signal: AbortSignal): Promise<LabelManifestResult> {
    const context = await selectionContext(this.plans, raw, signal);
    await this.assertSelected(context);
    await assertFilesRetained(this.inspection, context);
    const outcome: SelectionOutcome = { sources: [], skipped: [], decisions: [] };
    for (const source of context.loaded.manifest.sources) {
      await this.decide(source, context, outcome);
    }
    if (!outcome.sources.length) {
      throw labelFailure("CHANNEL.LABEL_NO_SOURCE");
    }
    const { input } = context.selection;
    const selection = { request: context.selection, decisions: outcome.decisions };
    await this.plans.publish(
      `v3/channel-labels/${input.operationId}/selection.json`,
      selection,
      signal,
    );
    const { sources, skipped } = outcome;
    const documents = input.admission
      ? sources.flatMap((source) =>
          source.kind === "text" && source.task.source.kind === "prepared"
            ? [source.task.source.document]
            : [],
        )
      : [];
    return this.plans.publishManifest({ input, sources, skipped, documents }, signal);
  }

  /** The selected image is registered and really holds a complete label. */
  private async assertSelected(context: SelectionContext): Promise<void> {
    const selected = context.selection.selectedImageId;
    if (selected === null) {
      return;
    }
    const registered = context.states.get(selected)?.status === "registered";
    const request = { input: context.selection.input, sourceId: selected };
    if (
      context.selectedIndex < 0 ||
      !registered ||
      !(await this.imageCheck(request, context.signal)).complete
    ) {
      throw unverified();
    }
  }

  private async decide(
    source: SavedEvidenceSource,
    context: SelectionContext,
    outcome: SelectionOutcome,
  ): Promise<void> {
    const state = finishedState(source, context);
    assertInOrder(source, { state, context });
    if (state.status === "not_started") {
      skip(outcome, source.id, { reason: "complete_label_already_selected" });
      return;
    }
    const skipped = await this.evidence.emptyOcr(source, { state, context });
    if (skipped) {
      skip(outcome, source.id, skipped);
      return;
    }
    await this.decideResolved(source, { state, context, outcome });
  }

  private async decideResolved(
    source: SavedEvidenceSource,
    at: { state: SourceState; context: SelectionContext; outcome: SelectionOutcome },
  ): Promise<void> {
    const { state, context, outcome } = at;
    const request = { input: context.selection.input, sourceId: source.id };
    const resolved = await this.plans.source(request, context.signal);
    if (resolved.status === "not_matched" || state.status === "not_matched") {
      if (resolved.status !== state.status) {
        throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
      }
      skip(outcome, source.id, { reason: "keyword_not_matched" });
      return;
    }
    const selected = context.selection.selectedImageId;
    if (source.kind === "file-image" && selected !== null && source.id !== selected) {
      const reason = await this.otherImage(resolved.source, { state, context });
      skip(outcome, source.id, reason);
      return;
    }
    outcome.sources.push(resolved.source);
  }

  /** An image other than the selected one may be skipped only if it provably does not hold a complete label. */
  private async otherImage(source: Source, at: { state: SourceState; context: SelectionContext }) {
    const { state, context } = at;
    if (state.status === "registered") {
      const request = { input: context.selection.input, sourceId: source.id };
      if ((await this.imageCheck(request, context.signal)).complete) {
        throw unverified();
      }
      return { reason: "incomplete_label", state };
    }
    if (state.status !== "review") {
      throw unverified();
    }
    return this.evidence.incompleteImage(source, { state, context });
  }
}

function skip(outcome: SelectionOutcome, id: string, decision: Record<string, unknown>): void {
  outcome.skipped.push(id);
  outcome.decisions.push({ id, ...decision });
}
