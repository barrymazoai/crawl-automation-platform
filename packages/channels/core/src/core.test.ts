import { describe, expect, it } from "vitest";
import type { ChannelAdapter } from "./adapter.js";
import { assertCaptureLane, captureLaneKind } from "./capture.js";
import { ChannelRegistry } from "./registry.js";

const httpOnly: ChannelAdapter = {
  id: "swanson",
  captureModes: ["http"],
  httpPolicy: {
    origins: ["https://www.swansonvitamins.com"],
    maxBytes: 1_000_000,
    timeoutMs: 5_000,
  },
  productAddress: (url) => ({ url, listingId: "x", variantId: null }),
  parseProduct: () => {
    throw new Error("not used");
  },
};

describe("capture lanes", () => {
  it("needs an HTTP lane for product capture (there is no browser product capture)", () => {
    expect(captureLaneKind("http")).toBe("http-lane");
  });

  it("refuses a browser permit for HTTP capture (the Swanson pilot's mistake)", () => {
    expect(() =>
      assertCaptureLane("http", { resourceId: "mini-ego-space-1", kind: "browser" }),
    ).toThrow(expect.objectContaining({ code: "CHANNEL.CAPTURE_LANE_MISMATCH" }));
    expect(() =>
      assertCaptureLane("http", { resourceId: "scraperapi-lane", kind: "http-lane" }),
    ).not.toThrow();
  });
});

describe("ChannelRegistry", () => {
  it("finds a registered channel and checks its capture mode", () => {
    const registry = new ChannelRegistry([httpOnly]);
    const noCapture = new ChannelRegistry([{ ...httpOnly, captureModes: [] }]);

    expect(registry.forCapture("swanson", "http").id).toBe("swanson");
    expect(() => noCapture.forCapture("swanson", "http")).toThrow(
      expect.objectContaining({ code: "CHANNEL.CAPTURE_MODE_UNSUPPORTED" }),
    );
  });

  it("refuses unknown and duplicate channels", () => {
    expect(() => new ChannelRegistry([httpOnly]).get("gnc")).toThrow(
      expect.objectContaining({ code: "CHANNEL.UNKNOWN" }),
    );
    expect(() => new ChannelRegistry([httpOnly, httpOnly])).toThrow(
      expect.objectContaining({ code: "CHANNEL.DUPLICATE" }),
    );
  });
});
