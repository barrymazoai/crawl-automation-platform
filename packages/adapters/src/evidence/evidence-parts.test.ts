import * as platform from "@crawl-automation/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceService } from "./evidence-parts.js";

function settings() {
  return {
    testPrefix: "tests/v3/pages",
    storage: {
      r2: {
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        bucket: "test-bucket",
        prefix: "production/evidence",
        timeoutMs: 1000,
      },
      r2Credentials: { accessKeyId: "unit-key", secretAccessKey: "unit-secret" },
    },
    channels: { forCapture: vi.fn() },
    createPages: vi.fn(),
    capture: {
      route: {
        routeId: "test",
        egressId: "test",
        version: "test/1",
        mode: "scraperapi" as const,
        managed: true as const,
        countryCode: "us",
        sessionNumber: null,
        responseMode: "html" as const,
        providerPolicy: "scraperapi-sync/1" as const,
      },
      scraperApi: { apiKey: "unit-test-key", allowedOrigins: ["https://page.test"] },
      channels: {},
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("test storage composition", () => {
  it("replaces the production scope with the explicit bucket-level test prefix", () => {
    const parts = settings();
    const store = new platform.R2Objects({ send: vi.fn() }, parts.storage.r2);
    const create = vi.spyOn(store, "create");
    const open = vi.spyOn(platform, "createR2Objects").mockReturnValue({ store, close: vi.fn() });
    createEvidenceService(parts);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      { ...parts.storage.r2, prefix: "tests/v3/pages" },
      parts.storage.r2Credentials,
    );
    expect(parts.storage.r2.prefix).toBe("production/evidence");
    expect(parts.createPages).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("uses the tier a request names for that channel only, in place of its configured one", async () => {
    const parts = settings();
    parts.capture.channels = { gnc: { premium: true }, amazon: { countryCode: "us" } } as never;
    const store = new platform.R2Objects({ send: vi.fn() }, parts.storage.r2);
    vi.spyOn(platform, "createR2Objects").mockReturnValue({ store, close: vi.fn() });
    const address = {
      url: "https://www.amazon.com/dp/B00SBZ2FFE",
      listingId: "B00SBZ2FFE",
      variantId: null,
    };
    parts.channels.forCapture.mockReturnValue({ productAddress: () => address, httpPolicy: {} });
    // A non-HTTP fetcher stops the capture before any intent is stored or credit is spent.
    parts.createPages.mockReturnValue({ mode: "browser" });
    const service = createEvidenceService(parts);
    await expect(
      service.capture({ channel: "amazon", url: address.url, tier: "ultraPremium" }),
    ).rejects.toMatchObject({ code: "EVIDENCE.BROWSER_CAPTURE_UNSUPPORTED" });
    expect(parts.createPages.mock.calls[0]?.[1].channels).toEqual({
      gnc: { premium: true },
      amazon: { countryCode: "us", premium: false, ultraPremium: true },
    });
  });

  it.each(["testPrefix", "storage", "capture"] as const)(
    "refuses missing %s without opening R2",
    async (missing) => {
      const open = vi.spyOn(platform, "createR2Objects");
      const service = createEvidenceService({ ...settings(), [missing]: undefined });
      await expect(
        service.capture({ channel: "gnc", url: "https://page.test/product" }),
      ).rejects.toMatchObject({
        code: "EVIDENCE.NOT_CONFIGURED",
      });
      expect(open).not.toHaveBeenCalled();
    },
  );
});
