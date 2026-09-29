import { describe, expect, it, vi } from "vitest";
import { ReviewRecordSchema, parseTextInput } from "@crawl-automation/v3-contracts";
import { decodeJson, hashString } from "../results/result-record.js";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { labelPlanSetup, selectionFor } from "../testing/label-fixture.js";
import { labelKeys } from "./label-plan-model.js";
import { LabelPlans } from "./label-plans.js";
import { labelSourceOperation } from "./label-source-task.js";

const signal = () => AbortSignal.timeout(10_000);

describe("label plans", () => {
  it("turns the page into a label text task and matched images into vision tasks, and publishes the manifest", async () => {
    const setup = await labelPlanSetup({ imageTexts: ["Marketing only", "Supplement Facts"] });
    const result = await setup.labelPlans.manifest(setup.input, signal());
    expect(result.skipped).toEqual(["image-0"]);
    const [text, image] = result.manifest.sources;
    if (text?.kind !== "text" || image?.kind !== "image") {
      throw new Error(JSON.stringify(result.manifest.sources));
    }
    expect(parseTextInput(text.task, hashString)).toMatchObject({
      operationId: labelSourceOperation(setup.input, "page"),
      implementationVersion: "codex-text/3",
      resultSchemaVersion: 3,
      range: setup.prepared.range,
    });
    expect(image.task).toMatchObject({
      configFingerprint: setup.input.visionConfigFingerprint,
      input: { extractionProtocol: "label-extraction/1" },
    });
    const stored = await setup.publication.remote.read(
      labelKeys.manifest(setup.input),
      2_000_000,
      signal(),
    );
    expect(decodeJson(defined(stored))).toEqual(result);
    expect(await setup.labelPlans.manifest(setup.input, signal())).toEqual(result);
  });

  it("a task with a core policy uses the label-core document, checked for its page and policy", async () => {
    const setup = await labelPlanSetup({ corePolicy: "gnc-label-core/1" });
    await expect(setup.labelPlans.manifest(setup.input, signal())).rejects.toMatchObject({
      code: "CHANNEL.CORE_UNAVAILABLE",
    });
    const document = {
      ...(setup.prepared.source.kind === "prepared"
        ? setup.prepared.source.document
        : defined(undefined)),
      objectKey: "v3/label-core/core-1/document.json",
    };
    const core = {
      inspect: vi.fn(async (raw: unknown) => ({
        status: "prepared",
        input: raw,
        document: {
          ...document,
          producer: {
            operationId: "core-1",
            module: "label.core.prepare",
            implementationVersion: "gnc-label-core/1",
          },
        },
        range: { start: 0, end: 12 },
      })),
    };
    const plans = new LabelPlans({
      plans: setup.plans,
      publication: setup.publication,
      resolve: setup.resolve,
      core,
    });
    const result = await plans.manifest(setup.input, signal());
    const text = defined(result.manifest.sources[0]);
    expect(text.kind === "text" && text.task.range).toEqual({ start: 0, end: 12 });
    const other = new LabelPlans({
      plans: setup.plans,
      publication: setup.publication,
      resolve: setup.resolve,
      core,
    });
    await expect(
      other.manifest(
        { ...setup.input, operationId: "other-label", corePolicy: "swanson-label-core/1" },
        signal(),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL.CORE_IDENTITY_CONFLICT",
    });
  });

  it("packaging admission lists the full page documents", async () => {
    const setup = await labelPlanSetup();
    const result = await setup.labelPlans.manifest(
      { ...setup.input, admission: "label-packaging/1" },
      signal(),
    );
    const document =
      setup.prepared.source.kind === "prepared" ? setup.prepared.source.document : null;
    expect(result.manifest.admission).toEqual({
      policy: "label-packaging/1",
      comparison: "label-typography/2",
      documents: [document],
    });
  });

  it("a plan for another product, an unprepared source or a foreign owner is refused", async () => {
    const setup = await labelPlanSetup();
    const foreignPlan = {
      ...setup.input,
      plan: { ...setup.input.plan, operationId: "other-plan" },
    };
    await expect(setup.labelPlans.manifest(foreignPlan, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_IDENTITY_CONFLICT",
    });
    setup.resolutions.set("image-1", { status: "review", code: "OCR.EMPTY" });
    await expect(setup.labelPlans.manifest(setup.input, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
    });
    const foreignOwner = { ...setup.input, owner: { ...setup.input.owner, listingId: "other" } };
    await expect(setup.labelPlans.manifest(foreignOwner, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_IDENTITY_CONFLICT",
    });
  });

  it("a product whose every source is skipped has no label", async () => {
    const setup = await labelPlanSetup({ imageTexts: ["Marketing only"] });
    setup.manifest.sources = setup.manifest.sources.filter(
      (source) => source.kind === "file-image",
    );
    await expect(setup.labelPlans.manifest(setup.input, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_NO_SOURCE",
    });
  });

  it("image-first orders images by filename hints, and must select before building a manifest", async () => {
    const setup = await labelPlanSetup();
    const input = { ...setup.input, evidencePolicy: "label-image-first/5" as const };
    expect((await setup.labelPlans.load(input, signal())).imageOrder).toEqual([
      "image-1",
      "image-0",
    ]);
    await expect(setup.labelPlans.manifest(input, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_SELECTION_REQUIRED",
    });
  });
});

describe("image-first selection", () => {
  const firstPolicy = { evidencePolicy: "label-image-first/5" as const };

  it("an image later than the selected one must be unstarted", async () => {
    const setup = await labelPlanSetup();
    const input = { ...setup.input, ...firstPolicy };
    const states = [
      { id: "page", status: "registered" },
      { id: "image-1", status: "registered" },
      { id: "image-0", status: "registered" },
    ];
    await expect(
      selectionFor(setup).selection.manifest(
        { input, selectedImageId: "image-1", states },
        signal(),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL.LABEL_SELECTION_UNVERIFIED",
    });
  });

  it("keeps the selected complete image and the page, and skips later images unstarted", async () => {
    const setup = await labelPlanSetup();
    const input = { ...setup.input, ...firstPolicy };
    const { selection } = selectionFor(setup);
    const states = [
      { id: "page", status: "registered" },
      { id: "image-1", status: "registered" },
      { id: "image-0", status: "not_started" },
    ];
    const result = await selection.manifest(
      { input, selectedImageId: "image-1", states },
      signal(),
    );
    expect(result.manifest.sources.map((source) => source.id)).toEqual(["page", "image-1"]);
    expect(result.skipped).toEqual(["image-0"]);
    const stored = await setup.publication.remote.read(
      labelKeys.selection(input),
      2_000_000,
      signal(),
    );
    expect(decodeJson(defined(stored))).toMatchObject({
      decisions: [{ id: "image-0", reason: "complete_label_already_selected" }],
    });
  });

  it("an earlier image whose OCR ran and found no text is skipped once its Review is verified", async () => {
    const setup = await labelPlanSetup({ factsIndex: 0 });
    const input = { ...setup.input, ...firstPolicy };
    setup.resolutions.set("image-0", { status: "review", code: "OCR.EMPTY" });
    const review = ReviewRecordSchema.parse({
      schemaVersion: 1,
      reviewId: "empty-ocr",
      occurredAt: "2026-09-28T00:00:00Z",
      observation: input.owner,
      failure: {
        schemaVersion: 1,
        requestId: "req-1",
        observationId: "obs-1",
        operationId: "ocr-op-0",
        inputFingerprint: "a".repeat(64),
        stage: "ocr.file",
        category: "PROCESSING",
        code: "OCR.EMPTY",
        executionFact: "executed",
        evidenceKey: "ocr-intents/ocr-op-0.json",
        blockedBy: null,
        automaticRetry: false,
      },
      rawError: { name: "OcrStageFailure", message: "OCR.EMPTY", stack: null, details: {} },
      candidate: null,
      inspection: { kind: "none" },
    });
    const { selection } = selectionFor(setup, { reviews: { "empty-ocr": review } });
    const states = [
      { id: "page", status: "registered" },
      { id: "image-1", status: "registered" },
      { id: "image-0", status: "review", reviewId: "empty-ocr" },
    ];
    const result = await selection.manifest(
      { input, selectedImageId: "image-1", states },
      signal(),
    );
    expect(result.skipped).toEqual(["image-0"]);
  });

  it("an earlier registered image that also holds a complete label makes the selection unverified", async () => {
    const setup = await labelPlanSetup({ factsIndex: 0 });
    const input = { ...setup.input, ...firstPolicy };
    const states = [
      { id: "page", status: "registered" },
      { id: "image-1", status: "registered" },
      { id: "image-0", status: "registered" },
    ];
    const { selection } = selectionFor(setup);
    await expect(
      selection.manifest({ input, selectedImageId: "image-1", states }, signal()),
    ).rejects.toMatchObject({
      code: "CHANNEL.LABEL_SELECTION_UNVERIFIED",
    });
    const incomplete = labelCandidate();
    incomplete.formulaComplete = false;
    const partial = selectionFor(setup, { candidates: { "image-0": incomplete } }).selection;
    const result = await partial.manifest(
      { input: { ...input, operationId: "partial-label" }, selectedImageId: "image-1", states },
      signal(),
    );
    expect(result.skipped).toEqual(["image-0"]);
  });

  it("a missing downloaded image stops the selection before anything is published", async () => {
    const setup = await labelPlanSetup();
    const input = { ...setup.input, ...firstPolicy };
    const states = [
      { id: "page", status: "registered" },
      { id: "image-1", status: "registered" },
      { id: "image-0", status: "not_started" },
    ];
    const { selection } = selectionFor(setup, { files: false });
    await expect(
      selection.manifest({ input, selectedImageId: "image-1", states }, signal()),
    ).rejects.toMatchObject({
      code: "CHANNEL.LABEL_FILE_UNVERIFIED",
    });
    expect(
      await setup.publication.remote.read(labelKeys.manifest(input), 2_000_000, signal()),
    ).toBeNull();
  });
});
