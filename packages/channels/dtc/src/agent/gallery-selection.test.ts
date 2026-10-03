import { rm } from "node:fs/promises";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processingIdentity } from "@crawl-automation/v3-contracts";
import { variantCaptureFixture } from "./variant-capture-fixture.js";
import { prepareMixedGallery } from "./mixed-gallery-fixture.js";
import { DtcGallerySelection } from "./gallery-selection.js";
import { GalleryModelOutput } from "./gallery-model-output.js";
import type { ScopePorts } from "./gallery-scope.js";

const signal = new AbortController().signal;
let fixture: Awaited<ReturnType<typeof variantCaptureFixture>>;
beforeEach(async () => {
  fixture = await variantCaptureFixture();
});
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

async function scoped(shared: boolean) {
  const prepared = await prepareMixedGallery(fixture);
  const decisions = [];
  for (const [index, image] of prepared.task.images.entries()) {
    decisions.push(
      await prepared.gallery.save(
        `decision/${index}.json`,
        {
          task: prepared.prepared.task,
          imageId: image.input.file.artifactId,
          decision: {
            kind: "facts",
            variantIds: [shared ? "1" : String(index + 1)],
            basis: "label-content",
            reason: "Observed Facts scope",
            imageEvidence: "Facts panel",
            websiteEvidence: "Observed website option",
          },
          ocr: prepared.prepared.task,
        },
        signal,
      ),
    );
  }
  return { ...prepared, request: { task: prepared.prepared.task, decisions } };
}

function ports(model: ScopePorts["model"]): ScopePorts {
  return {
    image: async (input) => Buffer.from(input.file.artifactId),
    ocr: async (input) => ({
      output: {
        ...processingIdentity(input),
        resultSchemaVersion: 2,
        provider: "test/1",
        text: "Retained Facts",
        rawResponse: { text: "Retained Facts", lines: [] },
      },
      result: { ...input.file, kind: "result-json", mediaType: "application/json" },
    }),
    model,
  };
}

it.each(["equivalent", "different", "invented"])(
  "jointly checks %s same-variant Facts without selecting by order",
  async (mode) => {
    const prepared = await scoped(true);
    const [firstImage, secondImage] = prepared.task.images;
    if (!firstImage || !secondImage) {
      throw new Error("fixture images missing");
    }
    const second = secondImage.input.file.artifactId;
    const model = vi.fn(async () =>
      JSON.stringify({
        selectedImageId:
          mode === "different" ? null : mode === "invented" ? "foreign-image" : second,
        reason:
          mode === "different"
            ? "Daily value differs by one percent"
            : "Same complete panel, second original more legible",
        comparisonEvidence:
          "Compared serving size, servings, amounts, units, DV, rows, other ingredients and footnotes across both originals",
      }),
    );
    const selection = new DtcGallerySelection(prepared.gallery, ports(model));
    if (mode === "invented") {
      await expect(selection.run(prepared.request, signal)).rejects.toThrow("SELECTION_OWNER");
      return;
    }
    const selections = await selection.run(prepared.request, signal);
    expect(await selection.run(prepared.request, signal)).toEqual(selections);
    expect(model).toHaveBeenCalledOnce();
    const call = model.mock.calls[0] as unknown as [Parameters<ScopePorts["model"]>[0]];
    expect(call[0].images?.map((image) => image.bytes)).toEqual(
      prepared.task.images.map((image) => Buffer.from(image.input.file.artifactId)),
    );
    const results = await prepared.gallery.finish({ ...prepared.request, selections }, signal);
    expect(results.map((member) => member.status)).toEqual(
      mode === "equivalent" ? ["ready", "review"] : ["review", "review"],
    );
    if (results[0]?.status === "ready") {
      const projection = await prepared.gallery.read(results[0].planned.sourcePlan.source, signal);
      expect(JSON.stringify(projection)).toContain(secondImage.url);
      expect(JSON.stringify(projection)).not.toContain(firstImage.url);
    }
  },
);

it("does not run a joint model when each variant has exactly one Facts image", async () => {
  const prepared = await scoped(false),
    model = vi.fn();
  expect(
    await new DtcGallerySelection(prepared.gallery, ports(model)).run(prepared.request, signal),
  ).toEqual([]);
  expect(model).not.toHaveBeenCalled();
});

it("retains an uncertain joint provider intent and refuses a second call", async () => {
  const prepared = await scoped(true);
  const model = vi.fn(async () => {
    throw new Error("provider failed");
  });
  const selection = new DtcGallerySelection(prepared.gallery, ports(model));
  await expect(selection.run(prepared.request, signal)).rejects.toThrow("provider failed");
  await expect(selection.run(prepared.request, signal)).rejects.toThrow("EXECUTION_UNKNOWN");
  expect(model).toHaveBeenCalledOnce();
});

it("prevents non-Facts variant assignments in the model output schema", () => {
  const decision = {
    kind: "other",
    variantIds: ["1"],
    basis: "not-facts",
    reason: "Package front",
    imageEvidence: "240 capsules",
    websiteEvidence: "240ct option",
  };
  expect(GalleryModelOutput.safeParse({ decision }).success).toBe(false);
  expect(GalleryModelOutput.safeParse({ decision: { ...decision, variantIds: [] } }).success).toBe(
    true,
  );
});

it("uses the provider-supported anyOf schema while retaining the three semantic branches", () => {
  const schema = z.toJSONSchema(GalleryModelOutput);
  expect(schema).toMatchObject({ properties: { decision: { anyOf: expect.any(Array) } } });
  expect(JSON.stringify(schema)).not.toContain('"oneOf"');
});
