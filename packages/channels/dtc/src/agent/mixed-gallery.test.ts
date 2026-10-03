import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DtcGalleryScope } from "./gallery-scope.js";
import { DtcMixedGallery, validateGalleryDecision } from "./mixed-gallery.js";
import { variantCaptureFixture } from "./variant-capture-fixture.js";
import {
  parseOcrInput,
  processingIdentity,
  type DtcGalleryDecision,
  type OcrOutput,
} from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/platform";
import { CaptureReviewAuthoringSchema, CaptureReviewSchema } from "./product-review.js";

const signal = new AbortController().signal;
let fixture: Awaited<ReturnType<typeof variantCaptureFixture>>;
beforeEach(async () => {
  fixture = await variantCaptureFixture();
});
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

async function prepare() {
  const { input } = fixture;
  input.review.variantContexts = fixture.contexts.map((context) => ({
    status: "mixed",
    basis: "variant-state",
    variantId: context.variantId,
    methodPath: context.methodPath,
    galleryUrls: input.record.gallery.map((image) => image.url),
    reason: "URL changes but both Facts remain in the carousel",
    evidence: context.evidence,
  }));
  await fixture.preflight();
  const variants = await fixture.publish();
  expect(variants.map((member) => member.status)).toEqual(["mixed", "mixed"]);
  const sourcePlan = await fixture.sourcePlans.publish(
    input.request,
    { parsed: input.parsed, planning: input.planning },
    signal,
  );
  await fixture.publication.publish(
    `v3/dtc-agent/${input.request.operationId}/images.json`,
    Buffer.from(
      JSON.stringify({
        version: "dtc-agent-images/1",
        url: input.request.url,
        images: input.images,
      }),
    ),
    "application/json",
    signal,
  );
  const gallery = new DtcMixedGallery(fixture.publication);
  const prepared = await gallery.prepare({ sourcePlan, variants }, signal);
  return { gallery, prepared, variants, task: await gallery.task(prepared.task, signal) };
}

function decision(variantId: string): DtcGalleryDecision {
  return {
    kind: "facts",
    variantIds: [variantId],
    basis: "label-content",
    reason: "The label identifies the website flavour",
    imageEvidence: variantId === "1" ? "Orange" : "Berry",
    websiteEvidence: variantId === "1" ? "Orange" : "Berry",
  };
}

it("requires per-variant reasons in the authoring contract while ingestion can isolate malformed siblings", async () => {
  await prepare();
  expect(CaptureReviewAuthoringSchema.safeParse(fixture.input.review).success).toBe(true);
  const raw = JSON.parse(JSON.stringify(fixture.input.review));
  delete raw.variantContexts[0].reason;
  expect(CaptureReviewAuthoringSchema.safeParse(raw).success).toBe(false);
  expect(CaptureReviewSchema.safeParse(raw).success).toBe(true);
  fixture.input.review = CaptureReviewSchema.parse(raw);
  fixture.input.request.operationId = "capture-authoring-invalid";
  expect((await fixture.publish()).map((member) => member.status)).toEqual(["review", "mixed"]);
});

it("keeps URL-changed mixed galleries unassigned until the prepass and preserves original bytes", async () => {
  const { gallery, prepared, variants, task } = await prepare();
  expect(prepared.inputs).toHaveLength(2);
  for (const input of prepared.inputs) {
    expect(parseOcrInput(input, (value) => sha256(Buffer.from(value)))).toEqual(input);
    expect(input.variantId).toBeNull();
    expect(input.file.producer.operationId).toBe(fixture.input.request.operationId);
  }
  const decisions = [];
  for (const [index, image] of task.images.entries()) {
    decisions.push(
      await gallery.save(
        `scope/${index}.json`,
        {
          task: prepared.task,
          imageId: image.input.file.artifactId,
          decision: decision(String(index + 1)),
          ocr: prepared.task,
        },
        signal,
      ),
    );
  }
  const output = await gallery.finish({ task: prepared.task, decisions }, signal);
  expect(output.map((member) => member.status)).toEqual(["ready", "ready"]);
  for (const [index, member] of output.entries()) {
    if (member.status !== "ready") {
      throw new Error("fixture");
    }
    expect(member.planned.family).toBeNull();
    expect(member.planned.labelText).toBeNull();
    expect(member.planned.factsComplete).toBe(false);
    const projection = (await gallery.read(member.planned.sourcePlan.source, signal)) as {
      evidence: { imageCandidates: { url: string }[]; factsCandidates: unknown[] };
    };
    expect(projection.evidence.imageCandidates.map((image) => image.url)).toEqual([
      task.images[index]?.url,
    ]);
    expect(projection.evidence.factsCandidates).toEqual([]);
    expect(member.variant).toEqual(variants[index]?.variant);
  }
  expect(fixture.input.record.gallery).toHaveLength(2);
});

it("retains unresolved Facts and reviews mixed members instead of assigning the first image", async () => {
  const { gallery, prepared, task } = await prepare();
  const decisions = [];
  for (const [index, image] of task.images.entries()) {
    decisions.push(
      await gallery.save(
        `scope/${index}.json`,
        {
          task: prepared.task,
          imageId: image.input.file.artifactId,
          decision: index
            ? {
                kind: "unresolved",
                variantIds: [],
                basis: "unresolved",
                reason: "Unreadable panel",
                imageEvidence: "",
                websiteEvidence: "",
              }
            : decision("1"),
          ocr: prepared.task,
        },
        signal,
      ),
    );
  }
  expect(
    (await gallery.finish({ task: prepared.task, decisions }, signal)).map(
      (member) => member.status,
    ),
  ).toEqual(["review", "review"]);
  await expect(
    gallery.finish({ task: prepared.task, decisions: decisions.slice(0, 1) }, signal),
  ).rejects.toThrow("RESULTS_INCOMPLETE");
});

it("rejects invented variants and missing semantic evidence without equating similar formulas", async () => {
  const { task } = await prepare();
  expect(() => validateGalleryDecision(task, decision("999"))).toThrow("INVENTED_VARIANT");
  expect(() => validateGalleryDecision(task, { ...decision("1"), imageEvidence: "" })).toThrow(
    "SCOPE_UNPROVEN",
  );
  expect(() => validateGalleryDecision(task, { ...decision("1"), kind: "other" })).toThrow(
    "SCOPE_UNPROVEN",
  );
});

it("uses original image plus verified OCR once, retains the answer, and refuses an uncertain second model execution", async () => {
  const { gallery, prepared, task } = await prepare();
  const image = task.images[0];
  if (!image) {
    throw new Error("fixture");
  }
  const output: OcrOutput = {
    ...processingIdentity(image.input),
    resultSchemaVersion: 2,
    provider: "test/1",
    text: "Orange Facts",
    rawResponse: { text: "Orange Facts", lines: [] },
  };
  const ocr = vi.fn(async () => ({
    output,
    result: {
      ...image.input.file,
      kind: "result-json" as const,
      mediaType: "application/json" as const,
    },
  }));
  const model = vi.fn(async (_call: { prompt: string; image: { bytes: Uint8Array } }) =>
    JSON.stringify(decision("1")),
  );
  const scope = new DtcGalleryScope(gallery, {
    ocr,
    image: async () => Buffer.from("original bytes"),
    model,
  });
  const request = { task: prepared.task, imageId: image.input.file.artifactId };
  const first = await scope.run(request, signal);
  expect(await scope.run(request, signal)).toEqual(first);
  expect(model).toHaveBeenCalledOnce();
  expect(ocr).toHaveBeenCalledOnce();
  expect(model.mock.calls[0]?.[0]).toMatchObject({
    image: { bytes: Buffer.from("original bytes") },
  });
  const root = `v3/dtc-gallery-scope/${sha256(Buffer.from(JSON.stringify(request)))}`;
  fixture.data.delete(`${root}/result.json`);
  await expect(scope.run(request, signal)).rejects.toThrow("EXECUTION_UNKNOWN");
  expect(model).toHaveBeenCalledOnce();
});

it("fails closed on altered retained image metadata before any provider call", async () => {
  const { gallery, prepared } = await prepare();
  fixture.data.set(prepared.task.objectKey, Buffer.from("{}"));
  await expect(gallery.task(prepared.task, signal)).rejects.toThrow("INTEGRITY");
});

it.each(["shared", "multiple"])(
  "handles %s Facts without first-image or sibling-formula reuse",
  async (mode) => {
    const { gallery, prepared, task } = await prepare();
    const decisions = [];
    for (const [index, image] of task.images.entries()) {
      const scope =
        index && mode === "shared"
          ? {
              kind: "other",
              variantIds: [],
              basis: "not-facts",
              reason: "Packaging front",
              imageEvidence: "",
              websiteEvidence: "",
            }
          : {
              ...decision("1"),
              variantIds: ["1", "2"],
              basis: "website-shared",
              websiteEvidence: "Both website flavours explicitly share this panel",
            };
      decisions.push(
        await gallery.save(
          `shared/${index}.json`,
          {
            task: prepared.task,
            imageId: image.input.file.artifactId,
            decision: scope,
            ocr: prepared.task,
          },
          signal,
        ),
      );
    }
    const result = await gallery.finish({ task: prepared.task, decisions }, signal);
    expect(result.map((member) => member.status)).toEqual(
      mode === "shared" ? ["ready", "ready"] : ["review", "review"],
    );
  },
);
