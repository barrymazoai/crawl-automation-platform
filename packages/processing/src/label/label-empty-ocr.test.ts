import { describe, expect, it } from "vitest";
import { OcrOutputSchema } from "@crawl-automation/v3-contracts";
import { ocrFailure } from "../ocr/ocr-errors.js";
import { decodeJson } from "../results/result-record.js";
import { defined } from "../testing/defined.js";
import { selectionFor } from "../testing/label-fixture.js";
import { labelOcrSetup, runLabelOcr } from "../testing/label-ocr-fixture.js";
import { signal } from "../testing/ocr-fixture.js";
import { labelKeys } from "./label-plan-model.js";
import { SavedSourceTasks } from "./saved-source-tasks.js";

describe("registered empty OCR in the shared label flow", () => {
  it.each(["", "  \n\t"])(
    "keeps two label images and records the third as no_text: %j",
    async (empty) => {
      const setup = await labelOcrSetup(["Supplement Facts", empty, "Other Ingredients"]);
      const receipts = await runLabelOcr(setup);
      expect(receipts.map((receipt) => receipt.status)).toEqual(Array(3).fill("registered"));
      const result = await setup.plans.manifest(setup.input, signal());
      expect(result.manifest.sources.map((source) => source.id)).toEqual(["image-0", "image-2"]);
      expect(result.skipped).toEqual(["image-1"]);
      const key = labelKeys.source(setup.input, "image-1");
      expect(decodeJson(defined(await setup.ocr.remote.read(key, 65_536)))).toMatchObject({
        status: "not_matched",
        reason: "no_text",
        input: { sourceId: "image-1" },
      });
      const record = defined(await setup.ocr.registry.read("ocr-op-1"));
      const bytes = defined(await setup.ocr.remote.read(record.result.objectKey, 524_288));
      expect(OcrOutputSchema.parse(decodeJson(bytes))).toMatchObject({
        text: empty,
        rawResponse: { text: empty, lines: [] },
      });
      expect(await setup.plans.manifest(setup.input, signal())).toEqual(result);
      expect(setup.ocr.reviews.records.size).toBe(0);
      expect(setup.recognize).toHaveBeenCalledTimes(3);
    },
  );

  it("all images empty and no page facts is label missing, with every skip retained", async () => {
    const setup = await labelOcrSetup(["", " \n", ""]);
    await runLabelOcr(setup);
    await expect(setup.plans.manifest(setup.input, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_NO_SOURCE",
    });
    for (const source of setup.images) {
      const bytes = await setup.ocr.remote.read(labelKeys.source(setup.input, source.id), 65_536);
      expect(decodeJson(defined(bytes))).toMatchObject({
        status: "not_matched",
        reason: "no_text",
      });
    }
    expect(setup.ocr.reviews.records.size).toBe(0);
    expect(setup.recognize).toHaveBeenCalledTimes(3);
  });

  it.each(["OCR.HTTP_STATUS", "OCR.TIMEOUT"] as const)(
    "%s still blocks the product without retry",
    async (code) => {
      const setup = await labelOcrSetup(["Supplement Facts", ocrFailure(code), "Ingredients"]);
      const receipts = await runLabelOcr(setup);
      expect(receipts[1]).toMatchObject({ status: "review", code, automaticRetry: false });
      await expect(setup.plans.manifest(setup.input, signal())).rejects.toMatchObject({
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
      });
      expect(setup.ocr.reviews.records.size).toBe(1);
      expect(setup.recognize).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["missing", "mismatched"])(
    "a %s empty OCR registration is still unconfirmed",
    async (damage) => {
      const setup = await labelOcrSetup([""]);
      await runLabelOcr(setup);
      const record = defined(setup.ocr.registry.data.get("ocr-op-0"));
      if (damage === "missing") {
        setup.ocr.registry.data.clear();
      } else {
        setup.ocr.registry.data.set("ocr-op-0", {
          ...record,
          input: { ...record.input, inputFingerprint: "f".repeat(64) },
        });
      }
      const tasks = new SavedSourceTasks({
        remote: setup.ocr.remote,
        pages: { inspect: async () => null },
        ocr: setup.ocr.registry,
        screen: setup.screen,
        reviews: setup.ocr.reviews,
        visionFingerprint: () => "",
      });
      const source = {
        id: "image-0",
        kind: "ocr-image" as const,
        required: true,
        task: record.input,
        visionOperationId: "vision-op-0",
        configFingerprint: "f".repeat(64),
      };
      await expect(tasks.registration(source)).rejects.toMatchObject({
        code: "SAVED.OCR_UNCONFIRMED",
      });
      await expect(setup.plans.manifest(setup.input, signal())).rejects.toMatchObject({
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
      });
      expect(setup.recognize).toHaveBeenCalledOnce();
    },
  );

  it("image-first selection also retains the verified no_text reason", async () => {
    const setup = await labelOcrSetup(["", "Supplement Facts"]);
    await runLabelOcr(setup);
    const input = { ...setup.input, evidencePolicy: "label-image-first/5" as const };
    // Try the no-text image first so the selection must account for its preparation.
    setup.plans.load = async () => ({
      input,
      manifest: setup.plan.manifest,
      imageOrder: ["image-0", "image-1"],
    });
    const { selection } = selectionFor({ ...setup.plan, labelPlans: setup.plans });
    const result = await selection.manifest(
      {
        input,
        selectedImageId: "image-1",
        states: [
          { id: "image-0", status: "not_matched" },
          { id: "image-1", status: "registered" },
        ],
      },
      signal(),
    );
    expect(result.skipped).toEqual(["image-0"]);
    const bytes = await setup.ocr.remote.read(labelKeys.selection(input), 65_536);
    expect(decodeJson(defined(bytes))).toMatchObject({
      decisions: [{ id: "image-0", reason: "no_text" }],
    });
  });
});
