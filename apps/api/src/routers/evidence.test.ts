import { EvidenceService, type EvidenceCaptureResult } from "@crawl-automation/app";
import { createLogger, type TemporalClient } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { ApiConfigSchema } from "../config.js";
import { assembleContainer } from "../container.js";
import productionShaped from "../fixtures/api-config.json" with { type: "json" };
import { appWith, post } from "../testing/app-with.js";

const input = { channel: "gnc" as const, url: "https://www.gnc.com/vitamins/123456.html" };
const result: EvidenceCaptureResult = {
  key: "tests/v3/pages/gnc/123456/observation.html",
  sha256: "f".repeat(64),
  size: 44,
  capturedAt: "2026-09-30T01:02:03.000Z",
  finalUrl: input.url,
  status: 200,
};

function configuredEvidence() {
  const { route, scraperApi } = productionShaped.brandScans;
  const evidence = { testPrefix: "tests/v3/pages", capture: { route, scraperApi } };
  const config = ApiConfigSchema.parse({ ...productionShaped, evidence });
  return assembleContainer({
    config,
    log: createLogger({ name: "evidence-test", level: "error" }),
    temporal: { client: {}, connection: {} } as unknown as TemporalClient,
  }).cradle.evidence;
}

describe("evidence.capture router", () => {
  it("accepts one mutation and returns the service's verified object metadata", async () => {
    const capture = vi.fn(async () => result);
    const evidence = new EvidenceService({ capture });
    const response = await appWith({ evidence }).request(
      "/trpc/evidence.capture",
      post({ ...input, note: "test" }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.data).toEqual(result);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      { ...input, note: "test", maximumAttempts: 1 },
      expect.any(AbortSignal),
    );
  });

  it.each([
    { channel: "unknown", url: input.url },
    { ...input, url: "invalid" },
    { ...input, note: "x".repeat(2001) },
    { ...input, maximumAttempts: 2 },
  ])("refuses invalid input before calling the service", async (body) => {
    const capture = vi.fn(async () => result);
    const response = await appWith({ evidence: { capture } }).request(
      "/trpc/evidence.capture",
      post(body),
    );
    expect(response.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each(["dtc", "wholefoods"])("reports a registered browser refusal for %s", async (channel) => {
    const response = await appWith({ evidence: new EvidenceService() }).request(
      "/trpc/evidence.capture",
      post({ ...input, channel }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.data.app.code).toBe(
      "EVIDENCE.BROWSER_CAPTURE_UNSUPPORTED",
    );
  });

  it("refuses an absent context service with a registered code", async () => {
    const response = await appWith({}).request("/trpc/evidence.capture", post(input));
    expect(response.status).toBe(500);
    expect((await response.json()).error.data.app.code).toBe("EVIDENCE.NOT_CONFIGURED");
  });

  it("refuses an unconfigured service before any paid fetch", async () => {
    const response = await appWith({ evidence: new EvidenceService() }).request(
      "/trpc/evidence.capture",
      post(input),
    );
    expect((await response.json()).error.data.app.code).toBe("EVIDENCE.NOT_CONFIGURED");
  });

  it("is a mutation, never a GET with side effects", async () => {
    const capture = vi.fn(async () => result);
    const response = await appWith({ evidence: { capture } }).request("/trpc/evidence.capture");
    expect(response.status).toBe(405);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("evidence composition with real channel hooks", () => {
  it.each([
    { channel: "gnc", url: "https://foreign.test/123456.html" },
    { channel: "swanson", url: "https://foreign.test/p/example" },
  ])("refuses a foreign site for $channel", async (body) => {
    const evidence = configuredEvidence();
    const response = await appWith({ evidence }).request("/trpc/evidence.capture", post(body));
    const code = (await response.json()).error.data.app.code;
    expect(["CHANNEL.URL_REJECTED", "GNC.URL_REJECTED"]).toContain(code);
  });

  it("refuses another site's page for the channel before any paid request", async () => {
    const response = await appWith({ evidence: configuredEvidence() }).request(
      "/trpc/evidence.capture",
      post({ channel: "swanson", url: "https://www.gnc.com/example/877080.html" }),
    );
    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.error.data.app.code).not.toBe("EVIDENCE.SINGLE_REQUEST_UNAVAILABLE");
  });
});
