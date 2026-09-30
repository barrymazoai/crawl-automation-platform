import { describe, expect, it } from "vitest";
import { assertCaptureGate } from "./capture.js";
import { ResourceKindsSchema, resourceKindOf } from "./resource-kinds.js";

const kindOf = resourceKindOf({
  "scraperapi-lane": "http-lane",
  "mini-ego-space-1": "browser",
  "mini-cpu": "cpu",
});
const need = (resourceId: string) => ({ resourceId, units: 1 });

describe("capture gate at startup", () => {
  it("accepts HTTP capture on the ScraperAPI lane, with other permits beside it", () => {
    expect(() =>
      assertCaptureGate(["http"], [need("scraperapi-lane"), need("mini-cpu")], kindOf),
    ).not.toThrow();
  });

  it("accepts browser capture on a browser space", () => {
    expect(() => assertCaptureGate(["browser"], [need("mini-ego-space-1")], kindOf)).not.toThrow();
  });

  it("refuses HTTP capture holding a browser permit (the Swanson pilot's mistake)", () => {
    expect(() =>
      assertCaptureGate(["http"], [need("scraperapi-lane"), need("mini-ego-space-1")], kindOf),
    ).toThrow(expect.objectContaining({ code: "CHANNEL.CAPTURE_LANE_MISMATCH" }));
  });

  it("refuses browser capture without a browser space", () => {
    expect(() => assertCaptureGate(["browser"], [need("scraperapi-lane")], kindOf)).toThrow(
      expect.objectContaining({ code: "CHANNEL.CAPTURE_LANE_MISMATCH" }),
    );
    expect(() => assertCaptureGate(["browser"], [need("mini-cpu")], kindOf)).toThrow(
      expect.objectContaining({ code: "CHANNEL.CAPTURE_LANE_MISSING" }),
    );
  });

  it("refuses a gate whose resource has no kind", () => {
    expect(() => assertCaptureGate(["http"], [need("unnamed-lane")], kindOf)).toThrow(
      expect.objectContaining({ code: "CHANNEL.RESOURCE_KIND_UNKNOWN" }),
    );
  });
});

describe("resource kinds in config", () => {
  it("reads the known kinds and refuses others", () => {
    expect(ResourceKindsSchema.safeParse({ "windows-ocr": "ocr" }).success).toBe(true);
    expect(ResourceKindsSchema.safeParse({ "windows-ocr": "gpu" }).success).toBe(false);
  });
});
