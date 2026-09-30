import { vi } from "vitest";
import { labelPlanSetup } from "../testing/label-fixture.js";
import { labelCandidate, visionFingerprint } from "../testing/label-sources.js";
import type { LabelSelection } from "./label-plan-model.js";
import { LabelImageSelection, type LabelInspection } from "./label-selection.js";

function fakeInspection(plan: Awaited<ReturnType<typeof labelPlanSetup>>) {
  return {
    file: vi.fn<LabelInspection["file"]>(async () => true),
    image: vi.fn<LabelInspection["image"]>(async () => labelCandidate()),
    review: vi.fn<LabelInspection["review"]>(async () => null),
    reviewSource: vi.fn<NonNullable<LabelInspection["reviewSource"]>>(
      async (source) => plan.resolutions.get(source.id) ?? { status: "not_matched" },
    ),
  };
}

/** In-memory plan repositories and inspection gateways for direct selection tests. */
export async function selectionFixture(factsIndex = 1) {
  const plan = await labelPlanSetup({ factsIndex });
  const input = { ...plan.input, evidencePolicy: "label-image-first/5" as const };
  const request: LabelSelection = {
    input,
    selectedImageId: "image-1",
    states: [
      { id: "page", status: "not_started" },
      { id: "image-0", status: factsIndex === 1 ? "not_started" : "registered" },
      { id: "image-1", status: "registered" },
    ],
  };
  const inspector = fakeInspection(plan);
  const selection = new LabelImageSelection(plan.labelPlans, {
    inspection: inspector,
    visionFingerprint,
  });
  const load = vi.spyOn(plan.labelPlans, "load");
  const source = vi.spyOn(plan.labelPlans, "source");
  const publish = vi.spyOn(plan.labelPlans, "publish");
  const publishManifest = vi.spyOn(plan.labelPlans, "publishManifest");
  return { plan, request, selection, inspector, load, source, publish, publishManifest };
}
