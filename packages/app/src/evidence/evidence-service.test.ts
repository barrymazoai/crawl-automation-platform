import { describe, expect, it, vi } from "vitest";
import { appErrors } from "../errors.js";
import { EvidenceService } from "./evidence-service.js";

const input = { channel: "gnc" as const, url: "https://www.gnc.com/vitamins/123456.html" };
const result = {
  key: "tests/v3/pages/gnc/123456/page.html",
  sha256: "a".repeat(64),
  size: 24,
  capturedAt: "2026-09-30T01:00:00.000Z",
  finalUrl: input.url,
  status: 200,
};

describe("manual evidence service", () => {
  it("makes one bounded capture with its optional note and returns verified evidence", async () => {
    const capture = vi.fn(async () => result);
    const service = new EvidenceService({ capture });
    await expect(service.capture({ ...input, note: "regression page" })).resolves.toEqual(result);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      { ...input, note: "regression page", maximumAttempts: 1 },
      expect.any(AbortSignal),
    );
  });

  it.each(["dtc", "wholefoods"] as const)("refuses %s before calling a port", async (channel) => {
    const capture = vi.fn(async () => result);
    await expect(
      new EvidenceService({ capture }).capture({ ...input, channel }),
    ).rejects.toMatchObject({
      code: "EVIDENCE.BROWSER_CAPTURE_UNSUPPORTED",
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("refuses absent capture configuration", async () => {
    await expect(new EvidenceService().capture(input)).rejects.toMatchObject({
      code: "EVIDENCE.NOT_CONFIGURED",
    });
  });

  it.each(["SCRAPERAPI.EXECUTION_UNKNOWN", "EVIDENCE.ARCHIVE_UNVERIFIED"])(
    "propagates %s without retrying",
    async (code) => {
      const failure =
        code === "EVIDENCE.ARCHIVE_UNVERIFIED"
          ? appErrors.create("EVIDENCE.ARCHIVE_UNVERIFIED")
          : new Error(code);
      const capture = vi.fn().mockRejectedValue(failure);
      await expect(new EvidenceService({ capture }).capture(input)).rejects.toBe(failure);
      expect(capture).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ url: "not-a-url" }, { note: "x".repeat(2001) }])(
    "checks input before capture: %j",
    async (invalid) => {
      const capture = vi.fn(async () => result);
      await expect(
        new EvidenceService({ capture }).capture({ ...input, ...invalid }),
      ).rejects.toThrow();
      expect(capture).not.toHaveBeenCalled();
    },
  );
});
