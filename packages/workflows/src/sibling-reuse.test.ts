import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  /** The patch markers the history being run carries. */
  patches: new Set(["formula-reuse-v1", "formula-reuse-ocr-v1"]),
  ocr: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  patched: (marker: string) => env.patches.has(marker),
  proxyActivities: () => ({}),
}));
vi.mock("./label/label-image-ocr.js", () => ({ ocrImage: env.ocr }));

import type { Manifest } from "./label/label-model.js";
import type { PipelineActivities, ProductPipelineInput } from "./pipeline-model.js";
import { reuseSiblingFormula } from "./sibling-reuse.js";

const owner = { listingId: "ribose-120", variantId: null };
const sourcePlan = { owner, operationId: "plan-1" };
const input = { runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11", channel: "swanson" };
const family = { differsBy: "size", members: [{ listingId: "ribose-60" }] };
const image = (id: string) => ({
  kind: "file-image",
  id,
  plan: { acquire: { operationId: `acquire-${id}` } },
});
const manifest = { sources: [{ kind: "page", id: "page" }, image("a"), image("b")] };
const matched = { status: "matched", ocrOperationId: "ocr-b" };
const reused = {
  status: "reused",
  formulaOperationId: "formula-60",
  linkId: "b".repeat(64),
  siblingListingId: "ribose-60",
  siblingVariantId: null,
};
const noText = { status: "extract", reason: "FORMULA.LABEL_TEXT_UNAVAILABLE" };
/** A downloaded label image, as the file step's receipt names it. */
const file = {
  schemaVersion: 1,
  artifactId: "image-a",
  observationId: "obs-1",
  sourceId: "source-1",
  listingId: "ribose-120",
  variantId: null,
  kind: "source-image",
  mediaType: "image/jpeg",
  objectKey: "sources/image-a.jpg",
  sha256: "c".repeat(64),
  byteSize: 1000,
  producer: { operationId: "file-a", module: "file.acquire", implementationVersion: "1" },
};

function activities(answers: unknown[]) {
  const reuse = vi.fn(async () => answers.shift());
  return {
    reuseSiblingFormula: reuse,
    prepareLabelTask: vi.fn(async () => ({ input: { owner }, queues: {}, resources: undefined })),
    acquireProductFile: vi.fn(async ({ acquire }: { acquire: { operationId: string } }) => ({
      status: "durable",
      operationId: acquire.operationId,
      evidenceKey: "files/one.json",
      file,
    })),
  } as unknown as PipelineActivities & { reuseSiblingFormula: typeof reuse };
}

function run(pipeline: PipelineActivities, labelText: string | null = null) {
  const captured = { status: "captured", sourcePlan, factsComplete: false, labelText, family };
  return reuseSiblingFormula({
    input: input as unknown as ProductPipelineInput,
    pipeline,
    captured: captured as never,
    plan: { status: "prepared", manifest: manifest as unknown as Manifest },
  });
}

beforeEach(() => {
  env.patches = new Set(["formula-reuse-v1", "formula-reuse-ocr-v1"]);
  env.ocr.mockReset();
});

describe("sibling reuse with the facts image", () => {
  it("reads the label images in order and asks again with the first facts image's OCR selection", async () => {
    env.ocr
      .mockResolvedValueOnce({ kind: "selection", selection: { status: "not_matched" } })
      .mockResolvedValueOnce({ kind: "selection", selection: matched });
    const pipeline = activities([noText, reused]);
    expect(await run(pipeline)).toMatchObject({ status: "collected", operationId: "formula-60" });
    expect(pipeline.acquireProductFile).toHaveBeenCalledTimes(2);
    expect(env.ocr).toHaveBeenCalledTimes(2);
    expect(pipeline.reuseSiblingFormula).toHaveBeenLastCalledWith(
      expect.objectContaining({ labelText: null, labelImage: matched }),
    );
  });

  it("extracts when the facts image differs from the sibling's formula", async () => {
    env.ocr.mockResolvedValue({ kind: "selection", selection: matched });
    const mismatch = { status: "extract", reason: "FORMULA.LABEL_MISMATCH" };
    const pipeline = activities([noText, mismatch]);
    expect(await run(pipeline)).toBeNull();
    expect(pipeline.reuseSiblingFormula).toHaveBeenCalledTimes(2);
  });

  it("extracts when no image shows a label, or an image's OCR ended in a Review", async () => {
    env.ocr
      .mockResolvedValueOnce({ kind: "state", state: { id: "a", status: "review" }, ready: true })
      .mockResolvedValueOnce({ kind: "selection", selection: { status: "not_matched" } });
    const pipeline = activities([noText]);
    expect(await run(pipeline)).toBeNull();
    expect(pipeline.reuseSiblingFormula).toHaveBeenCalledOnce();
  });

  it("stops at a file Review without reading any image", async () => {
    const pipeline = activities([noText]);
    vi.mocked(pipeline.acquireProductFile).mockResolvedValue({
      status: "review",
      operationId: "acquire-a",
      reviewId: "review-a",
      code: "FILE.UNAVAILABLE",
      evidenceKey: "reviews/a.json",
      automaticRetry: false,
    });
    expect(await run(pipeline)).toBeNull();
    expect(env.ocr).not.toHaveBeenCalled();
  });

  it("reads no image when the page's facts text already answered, or no sibling formula exists", async () => {
    const pipeline = activities([{ status: "extract", reason: "FORMULA.NO_SIBLING_FORMULA" }]);
    expect(await run(pipeline)).toBeNull();
    const withText = activities([reused]);
    expect(await run(withText, "D-Ribose 500 mg")).toMatchObject({ status: "collected" });
    expect(env.ocr).not.toHaveBeenCalled();
    expect(pipeline.prepareLabelTask).not.toHaveBeenCalled();
  });

  it("a history recorded before the OCR patch replays without reading any image", async () => {
    env.patches.delete("formula-reuse-ocr-v1");
    const pipeline = activities([noText]);
    expect(await run(pipeline)).toBeNull();
    expect(pipeline.prepareLabelTask).not.toHaveBeenCalled();
    expect(pipeline.reuseSiblingFormula).toHaveBeenCalledOnce();
  });
});
