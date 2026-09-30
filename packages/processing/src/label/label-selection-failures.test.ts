import { describe, expect, it, vi } from "vitest";
import { labelCandidate } from "../testing/label-sources.js";
import { selectionFixture } from "./selection-test-helpers.js";

describe("LabelImageSelection.manifest dependency failures", () => {
  it("refuses a missing original even if that image was never started", async () => {
    const fake = await selectionFixture();
    fake.inspector.file.mockImplementation(async (source) => source.id !== "image-0");
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_FILE_UNVERIFIED" });
    expect(fake.publishManifest).not.toHaveBeenCalled();
    expect(fake.publish.mock.calls.some(([key]) => key.endsWith("/selection.json"))).toBe(false);
  });

  it("waits for the whole retention-check batch before returning a failure", async () => {
    const fake = await selectionFixture();
    const failure = new Error("original unreadable");
    let finish = (_retained: boolean): void => {
      throw new Error("retention check not started");
    };
    const remaining = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    fake.inspector.file.mockRejectedValueOnce(failure).mockReturnValueOnce(remaining);
    let finished = false;
    const outcome = fake.selection
      .manifest(fake.request, new AbortController().signal)
      .catch((error: unknown) => {
        finished = true;
        return error;
      });
    await vi.waitFor(() => expect(fake.inspector.file).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    finish(true);
    expect(await outcome).toBe(failure);
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it("propagates plan-load failures before inspecting or publishing", async () => {
    const fake = await selectionFixture();
    const failure = new Error("plan unavailable");
    fake.load.mockRejectedValue(failure);
    await expect(fake.selection.manifest(fake.request, new AbortController().signal)).rejects.toBe(
      failure,
    );
    expect(fake.inspector.file).not.toHaveBeenCalled();
    expect(fake.inspector.image).not.toHaveBeenCalled();
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it("does not publish a manifest if the selection decision cannot be archived", async () => {
    const fake = await selectionFixture();
    const failure = new Error("selection publication failed");
    const original = fake.plan.labelPlans.publish.bind(fake.plan.labelPlans);
    fake.publish.mockRestore();
    const publish = vi
      .spyOn(fake.plan.labelPlans, "publish")
      .mockImplementation(async (key, value, signal) => {
        if (key.endsWith("/selection.json")) {
          throw failure;
        }
        await original(key, value, signal);
      });
    await expect(fake.selection.manifest(fake.request, new AbortController().signal)).rejects.toBe(
      failure,
    );
    expect(publish.mock.calls.filter(([key]) => key.endsWith("/selection.json"))).toHaveLength(1);
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it("preserves a manifest publication failure without retrying the write", async () => {
    const fake = await selectionFixture();
    const failure = new Error("manifest publication unverified");
    fake.publishManifest.mockRejectedValue(failure);
    await expect(fake.selection.manifest(fake.request, new AbortController().signal)).rejects.toBe(
      failure,
    );
    expect(fake.publishManifest).toHaveBeenCalledOnce();
  });

  it("rejects a malformed selection before loading the plan", async () => {
    const fake = await selectionFixture();
    await expect(
      fake.selection.manifest({ ...fake.request, extra: true }, new AbortController().signal),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fake.load).not.toHaveBeenCalled();
  });

  it("skips an earlier incomplete image only after inspecting its candidate", async () => {
    const fake = await selectionFixture(0);
    fake.inspector.image.mockImplementation(async (source) => ({
      ...labelCandidate(),
      formulaComplete: source.id === "image-1",
    }));
    const result = await fake.selection.manifest(fake.request, new AbortController().signal);
    expect(result.skipped).toContain("image-0");
    expect(fake.inspector.image.mock.calls.map(([source]) => source.id)).toEqual([
      "image-1",
      "image-0",
    ]);
    expect(fake.publish).toHaveBeenCalledWith(
      expect.stringMatching(/\/selection.json$/),
      expect.objectContaining({
        decisions: expect.arrayContaining([
          {
            id: "image-0",
            reason: "incomplete_label",
            state: { id: "image-0", status: "registered" },
          },
        ]),
      }),
      expect.any(AbortSignal),
    );
  });

  it.each(["image-1", null])(
    "retains the full page document for packaging admission with selected image %s",
    async (selectedImageId) => {
      const fake = await selectionFixture();
      fake.request.input.admission = "label-packaging/1";
      fake.request.states[0] = { id: "page", status: "registered" };
      fake.request.selectedImageId = selectedImageId;
      if (selectedImageId === null) {
        fake.request.states = fake.request.states.map(({ id }) => ({ id, status: "registered" }));
      }
      const prepared = fake.plan.prepared.source;
      if (prepared.kind !== "prepared") {
        throw new Error("fixture page must have a prepared document");
      }
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).resolves.toMatchObject({
        manifest: {
          admission: {
            policy: "label-packaging/1",
            comparison: "label-typography/2",
            documents: [prepared.document],
          },
        },
      });
    },
  );

  it("does not borrow a document from a skipped page to satisfy packaging admission", async () => {
    const fake = await selectionFixture();
    fake.request.input.admission = "label-packaging/1";
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fake.publishManifest).toHaveBeenCalledWith(
      expect.objectContaining({ documents: [], skipped: ["page", "image-0"] }),
      expect.any(AbortSignal),
    );
    expect(fake.plan.resolve.mock.calls.some(([source]) => source.id === "page")).toBe(false);
  });

  it("does not substitute a label-core fragment for a full packaging document", async () => {
    const fake = await selectionFixture();
    fake.request.input.admission = "label-packaging/1";
    fake.request.states[0] = { id: "page", status: "registered" };
    fake.source.mockRestore();
    const resolve = fake.plan.labelPlans.source.bind(fake.plan.labelPlans);
    vi.spyOn(fake.plan.labelPlans, "source").mockImplementation(async (request, signal) => {
      const result = await resolve(request, signal);
      if (result.status === "prepared" && result.source.kind === "text") {
        const source = result.source.task.source;
        if (source.kind === "prepared") {
          source.document.producer.module = "label.core.prepare";
        }
      }
      return result;
    });
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
