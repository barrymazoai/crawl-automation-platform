import { describe, expect, it } from "vitest";
import { checkWorkerResources, type CheckedSettings } from "./resource-check.js";

const need = (resourceId: string) => ({ resourceId, units: 1 });

/** Server 一's label permits as configured on 2026-09-30 (resource IDs only). */
function gate(activities: Record<string, { resourceId: string; units: number }[]>) {
  return { queue: "v3.resources.v1", releaseOnReview: true, maxWaitSeconds: 900, activities };
}
const serverOneGate = gate({
  interpretText: [need("mini-model-account"), need("mini-cpu")],
  interpretImage: [need("mini-model-account"), need("mini-cpu")],
  ocrFile: [need("windows-ocr")],
});

/** Only the parts the check reads; the rest of the worker settings is irrelevant here. */
function settings(overrides: Record<string, unknown> = {}): CheckedSettings {
  const label = { resources: serverOneGate, shared: { resources: serverOneGate } };
  return { label, resourceKinds: {}, ...overrides } as unknown as CheckedSettings;
}

describe("worker resources at startup", () => {
  it("accepts Server 一's permits without a resourceKinds section", () => {
    expect(() => checkWorkerResources(settings())).not.toThrow();
  });

  it("refuses a model call without a model permit", () => {
    const label = { resources: gate({ interpretText: [need("mini-cpu")] }) };
    expect(() => checkWorkerResources(settings({ label }))).toThrow(
      expect.objectContaining({ code: "WORKER.RESOURCE_KIND_MISMATCH" }),
    );
  });

  it("refuses a capture lane on a label step (a browser permit for OCR)", () => {
    const label = { resources: gate({ ocrFile: [need("windows-ocr"), need("mini-ego-space-1")] }) };
    const resourceKinds = { "mini-ego-space-1": "browser" as const };
    const checked = settings({ label, resourceKinds });
    expect(() => checkWorkerResources(checked)).toThrow(
      expect.objectContaining({ code: "WORKER.RESOURCE_KIND_MISMATCH" }),
    );
  });

  it("refuses a permit whose resource has no kind, and accepts it once named", () => {
    const label = { resources: gate({ ocrFile: [need("gpu-ocr")] }) };
    expect(() => checkWorkerResources(settings({ label }))).toThrow(
      expect.objectContaining({ code: "CHANNEL.RESOURCE_KIND_UNKNOWN" }),
    );
    const named = { label, resourceKinds: { "gpu-ocr": "ocr" as const } };
    expect(() => checkWorkerResources(settings(named))).not.toThrow();
  });

  it("refuses the browser role on a machine without browser settings", () => {
    const processes = { browser: { roles: [{ role: "browser" as const, taskQueue: "b" }] } };
    expect(() => checkWorkerResources(settings({ processes }))).toThrow(
      expect.objectContaining({ code: "WORKER.BROWSER_SETTINGS_MISSING" }),
    );
  });
});
