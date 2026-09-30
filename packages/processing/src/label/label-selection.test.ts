import { describe, expect, it } from "vitest";
import { labelCandidate } from "../testing/label-sources.js";
import { selectionFixture } from "./selection-test-helpers.js";

describe("LabelImageSelection.imageCheck", () => {
  it("returns the parsed request and complete=true only for an intact registered image", async () => {
    const fake = await selectionFixture();
    const request = { input: fake.request.input, sourceId: "image-1" };
    const signal = new AbortController().signal;
    expect(await fake.selection.imageCheck(request, signal)).toEqual({
      input: request,
      complete: true,
    });
    expect(fake.source).toHaveBeenCalledExactlyOnceWith(request, signal);
    expect(fake.inspector.image).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "image-1", kind: "image" }),
      signal,
    );
  });

  it.each(["formulaComplete", "ingredientsComplete"] as const)(
    "returns incomplete when %s is false",
    async (field) => {
      const fake = await selectionFixture();
      const candidate = labelCandidate();
      candidate[field] = false;
      fake.inspector.image.mockResolvedValue(candidate);
      expect(
        await fake.selection.imageCheck(
          { input: fake.request.input, sourceId: "image-1" },
          new AbortController().signal,
        ),
      ).toMatchObject({ complete: false });
    },
  );

  it("does not accept a complete candidate whose ingredient integrity check fails", async () => {
    const fake = await selectionFixture();
    const candidate = labelCandidate();
    if (!candidate.otherIngredients) {
      throw new Error("fixture has no ingredients");
    }
    candidate.otherIngredients.items = [{ text: "(gelatin)", evidence: "(gelatin)" }];
    fake.inspector.image.mockResolvedValue(candidate);
    expect(
      await fake.selection.imageCheck(
        { input: fake.request.input, sourceId: "image-1" },
        new AbortController().signal,
      ),
    ).toMatchObject({ complete: false });
  });

  it.each([undefined, "label-image-first/4"] as const)(
    "refuses unsupported evidence policy %j before resolving a source",
    async (evidencePolicy) => {
      const fake = await selectionFixture();
      const input = { ...fake.request.input, evidencePolicy };
      await expect(
        fake.selection.imageCheck({ input, sourceId: "image-1" }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNAVAILABLE" });
      expect(fake.source).not.toHaveBeenCalled();
      expect(fake.inspector.image).not.toHaveBeenCalled();
    },
  );

  it.each(["page", "not_matched"])("refuses a %s result as a selected image", async (kind) => {
    const fake = await selectionFixture();
    if (kind === "not_matched") {
      fake.plan.resolutions.set("image-1", { status: "not_matched" });
    }
    const sourceId = kind === "page" ? "page" : "image-1";
    await expect(
      fake.selection.imageCheck(
        { input: fake.request.input, sourceId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
    expect(fake.inspector.image).not.toHaveBeenCalled();
  });

  it("rejects malformed requests before touching the plan", async () => {
    const fake = await selectionFixture();
    await expect(fake.selection.imageCheck({}, new AbortController().signal)).rejects.toMatchObject(
      { name: "ZodError" },
    );
    expect(fake.source).not.toHaveBeenCalled();
  });

  it.each(["source", "inspection"])("propagates %s errors without retrying", async (dependency) => {
    const fake = await selectionFixture();
    const failure = new Error("source unavailable");
    const failing = dependency === "source" ? fake.source : fake.inspector.image;
    failing.mockRejectedValue(failure);
    await expect(
      fake.selection.imageCheck(
        { input: fake.request.input, sourceId: "image-1" },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(failing).toHaveBeenCalledOnce();
  });
});

describe("LabelImageSelection.manifest selection checks", () => {
  it("retains every image, skips unstarted sources with reasons, then publishes selection before manifest", async () => {
    const fake = await selectionFixture();
    const signal = new AbortController().signal;
    const result = await fake.selection.manifest(fake.request, signal);
    expect(result.manifest.sources.map((source) => source.id)).toEqual(["image-1"]);
    expect(result.skipped).toEqual(["page", "image-0"]);
    expect(fake.inspector.file.mock.calls.map(([source]) => source.id)).toEqual([
      "image-0",
      "image-1",
    ]);
    expect(fake.publish).toHaveBeenCalledWith(
      `v3/channel-labels/${fake.request.input.operationId}/selection.json`,
      {
        request: fake.request,
        decisions: ["page", "image-0"].map((id) => ({
          id,
          reason: "complete_label_already_selected",
        })),
      },
      signal,
    );
    expect(fake.publishManifest).toHaveBeenCalledExactlyOnceWith(
      {
        input: fake.request.input,
        sources: result.manifest.sources,
        skipped: result.skipped,
        documents: [],
      },
      signal,
    );
    const selectionIndex = fake.publish.mock.calls.findIndex(([key]) =>
      key.endsWith("/selection.json"),
    );
    expect(fake.publish.mock.invocationCallOrder[selectionIndex]).toBeLessThan(
      fake.publishManifest.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each(["missing", "duplicate", "unknown"])(
    "refuses %s source states before reading images",
    async (problem) => {
      const fake = await selectionFixture();
      if (problem === "missing") {
        fake.request.states.pop();
      }
      if (problem === "duplicate") {
        fake.request.states.push({ id: "page", status: "not_started" });
      }
      if (problem === "unknown") {
        fake.request.states[0] = { id: "foreign", status: "not_started" };
      }
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
      expect(fake.inspector.image).not.toHaveBeenCalled();
      expect(fake.publishManifest).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "unregistered", "incomplete"])(
    "refuses an %s selected image",
    async (problem) => {
      const fake = await selectionFixture();
      if (problem === "unknown") {
        fake.request.selectedImageId = "foreign";
      }
      if (problem === "unregistered") {
        fake.request.states[2] = { id: "image-1", status: "review", reviewId: "review" };
      }
      if (problem === "incomplete") {
        fake.inspector.image.mockResolvedValue({ ...labelCandidate(), formulaComplete: false });
      }
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
      expect(fake.inspector.file).not.toHaveBeenCalled();
      expect(fake.publishManifest).not.toHaveBeenCalled();
    },
  );

  it.each(["unresolved", "rejected"] as const)(
    "refuses a %s source state without publishing a manifest",
    async (status) => {
      const fake = await selectionFixture();
      fake.request.states[0] = { id: "page", status };
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED" });
      expect(fake.publishManifest).not.toHaveBeenCalled();
    },
  );

  it("refuses unstarted sources when no complete image has been selected", async () => {
    const fake = await selectionFixture();
    fake.request.selectedImageId = null;
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it("refuses an earlier unstarted image even when a later one is complete", async () => {
    const fake = await selectionFixture(0);
    fake.request.states[1] = { id: "image-0", status: "not_started" };
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it("keeps all prepared sources when no image is selected", async () => {
    const fake = await selectionFixture();
    fake.request.selectedImageId = null;
    fake.request.states = fake.request.states.map(({ id }) => ({ id, status: "registered" }));
    const result = await fake.selection.manifest(fake.request, new AbortController().signal);
    expect(result.manifest.sources.map((source) => source.id)).toEqual([
      "page",
      "image-0",
      "image-1",
    ]);
    expect(result.skipped).toEqual([]);
    expect(fake.inspector.image).not.toHaveBeenCalled();
  });

  it.each(["registered", "not_matched"] as const)(
    "refuses inconsistent preparation when the state is %s",
    async (status) => {
      const fake = await selectionFixture(0);
      fake.request.states[1] = { id: "image-0", status };
      if (status === "registered") {
        fake.plan.resolutions.set("image-0", { status: "not_matched" });
      }
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
      expect(fake.publishManifest).not.toHaveBeenCalled();
    },
  );

  it("reports no source when every prepared image is keyword-unmatched", async () => {
    const fake = await selectionFixture();
    fake.plan.manifest.sources = fake.plan.manifest.sources.filter(
      (source) => source.kind === "file-image",
    );
    fake.request.selectedImageId = null;
    fake.request.states = ["image-0", "image-1"].map((id) => ({ id, status: "not_matched" }));
    fake.request.states.forEach(({ id }) =>
      fake.plan.resolutions.set(id, { status: "not_matched" }),
    );
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_NO_SOURCE" });
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });
});
