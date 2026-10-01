import { vi } from "vitest";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import {
  imageSource,
  textEntry,
  labelCandidate,
  fixtureObservation,
  visionFingerprint,
} from "../testing/label-sources.js";
import { planImageSource, planPageSource } from "../testing/label-plan-sources.js";
import { LabelOrderedSelection } from "./ordered-selection.js";
import type { LabelPlans, LoadedPlan } from "./label-plans.js";
import type { LabelInspection } from "./selection-model.js";
import type { OrderedSource } from "./ordered-model.js";
import { LabelPlanInputSchema } from "./label-plan-model.js";

interface Options {
  order?: "images-first" | "text-first";
  candidates?: LabelImageCandidate[];
  text?: LabelImageCandidate;
  pageHasLabelSection?: boolean;
}
function taskInput(options: Options, task: ReturnType<typeof textEntry>["record"]["input"]) {
  const sourcePolicy = { version: "label-sources/1", order: options.order ?? "images-first" };
  const {
    schemaVersion,
    module,
    implementationVersion,
    policyVersion,
    resultSchemaVersion,
    configFingerprint,
  } = task;
  return LabelPlanInputSchema.parse({
    operationId: "ordered-label",
    owner: fixtureObservation,
    plan: { operationId: "product-plan", sourceOperationId: "capture", input: { sourcePolicy } },
    text: {
      schemaVersion,
      module,
      implementationVersion,
      policyVersion,
      resultSchemaVersion,
      configFingerprint,
    },
    visionConfigFingerprint: "a".repeat(64),
    evidencePolicy: "label-image-first/6",
    sourcePolicy,
  });
}

/** Synthetic registered answers exercise the real merger and receipt identity checks. */
async function fixtureData(options: Options) {
  const text = textEntry(options.text ?? labelCandidate());
  const page = await planPageSource();
  const images = (options.candidates ?? [labelCandidate(), labelCandidate()]).map(imageSource);
  const input = taskInput(options, text.record.input);
  const sources = [
    { ...page.source, id: text.id },
    ...images.map((image, index) => ({
      ...planImageSource(index, { text: "Supplement Facts", factsIndex: 0 }).source,
      id: image.source.id,
    })),
  ];
  const loaded = {
    input,
    manifest: { operationId: "product-plan", observation: fixtureObservation, sources },
    imageOrder: images.map((image) => image.source.id),
    labelPreparation: {
      pageHasLabelSection: options.pageHasLabelSection ?? true,
      pageFactsComplete: true,
    },
  } satisfies LoadedPlan;
  const entries = new Map(
    [text, ...images.map((image) => image.entry)].map((entry) => [entry.id, entry]),
  );
  const tasks = new Map<string, OrderedSource>([
    [text.id, { id: text.id, kind: "text", required: true, task: text.record.input }],
    ...images.map((image) => [image.source.id, image.source] as [string, OrderedSource]),
  ]);
  return { loaded, entries, tasks };
}

export async function orderedFixture(options: Options = {}) {
  const { loaded, entries, tasks } = await fixtureData(options);
  const plans = {
    load: vi.fn(async () => loaded),
    source: vi.fn(async (request: { sourceId: string }) => ({
      input: request,
      status: "prepared",
      source: tasks.get(request.sourceId),
    })),
    publish: vi.fn(),
    publishManifest: vi.fn(async (parts: unknown) => parts),
  };
  const inspection: LabelInspection = {
    file: vi.fn(async () => true),
    image: vi.fn(),
    review: vi.fn(async () => null),
    readSource: vi.fn(async (source) => {
      const entry = entries.get(source.id);
      if (!entry) {
        throw new Error("Missing synthetic entry");
      }
      return entry;
    }),
  };
  const selection = new LabelOrderedSelection(plans as unknown as LabelPlans, {
    inspection,
    visionFingerprint,
  });
  return { input: loaded.input, loaded, selection, plans, inspection, entries, tasks };
}
