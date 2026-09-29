import { vi } from "vitest";
import { RetainedPublication } from "@crawl-automation/v3-artifacts";
import type { LabelImageCandidate, SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import type { SourceResolution } from "../label/label-plan-model.js";
import { LabelPlans } from "../label/label-plans.js";
import { LabelImageSelection } from "../label/label-selection.js";
import { labelCandidate, visionFingerprint } from "./label-sources.js";
import { planImageSource, planOwner, planPageSource } from "./label-plan-sources.js";
import { MemoryStore } from "./memory-store.js";

const labelText = {
  schemaVersion: 1 as const,
  module: "codex.text" as const,
  implementationVersion: "codex-text/3",
  policyVersion: "label-text/4",
  resultSchemaVersion: 3 as const,
  configFingerprint: "d".repeat(64),
};

/** A label task for the fixture product plan. */
function labelInput(corePolicy: string | undefined) {
  const plan = {
    operationId: "product-plan",
    sourceOperationId: "capture-1",
    input: { channel: "synthetic" },
  };
  const core = corePolicy ? { corePolicy } : {};
  return {
    operationId: "channel-label",
    owner: planOwner,
    plan,
    text: labelText,
    visionConfigFingerprint: "b".repeat(64),
    ...core,
  };
}

/** Resolves a source from the given table; an unknown source is an unverified preparation. */
function resolverOf(resolutions: Map<string, SourceResolution>) {
  const unverified = { status: "review" as const, code: "SAVED.PREPARATION_UNVERIFIED" };
  return vi.fn(async (source: SavedEvidenceSource) => resolutions.get(source.id) ?? unverified);
}

/** A product plan with one page and two images; the one at `factsIndex` (default 1) is named as the facts panel. */
export async function labelPlanSetup(
  options: { corePolicy?: string; imageTexts?: string[]; factsIndex?: number } = {},
) {
  const page = await planPageSource();
  const texts = options.imageTexts ?? ["Supplement Facts", "Supplement Facts"];
  const images = texts.map((text, index) =>
    planImageSource(index, { text, factsIndex: options.factsIndex ?? 1 }),
  );
  const sources = [page.source, ...images.map((image) => image.source)];
  const manifest = { operationId: "product-plan", observation: planOwner, sources };
  const resourceOf = (source: SavedEvidenceSource) =>
    source.kind === "file-image" ? source.plan.acquire.resourceId : "";
  const files = images.map((image) => ({ resourceId: resourceOf(image.source), url: image.url }));
  const resolutions = new Map<string, SourceResolution>([
    ["page", page.resolution],
    ...images.map((image) => [image.source.id, image.resolution] as [string, SourceResolution]),
  ]);
  const resolve = resolverOf(resolutions);
  const plans = { inspect: vi.fn(async () => ({ manifest, files })) };
  const publication = new RetainedPublication(new MemoryStore(), new MemoryStore());
  const labelPlans = new LabelPlans({ plans, publication, resolve });
  const input = labelInput(options.corePolicy);
  return {
    page: page.page,
    prepared: page.task,
    images,
    manifest,
    resolutions,
    resolve,
    plans,
    publication,
    input,
    labelPlans,
  };
}

/** Image-first selection over the setup, with image answers and Reviews supplied per image. */
export function selectionFor(
  setup: Awaited<ReturnType<typeof labelPlanSetup>>,
  inspection: {
    candidates?: Record<string, LabelImageCandidate>;
    reviews?: Record<string, unknown>;
    files?: boolean;
  } = {},
) {
  const candidates = inspection.candidates ?? {};
  const notMatched = { status: "not_matched" as const };
  const inspector = {
    file: vi.fn(async () => inspection.files ?? true),
    image: vi.fn(async (source: { id: string }) => candidates[source.id] ?? labelCandidate()),
    review: vi.fn(async (id: string) => inspection.reviews?.[id] ?? null),
    reviewSource: vi.fn(
      async (source: SavedEvidenceSource) => setup.resolutions.get(source.id) ?? notMatched,
    ),
  };
  return {
    inspector,
    selection: new LabelImageSelection(setup.labelPlans, {
      inspection: inspector,
      visionFingerprint,
    }),
  };
}
