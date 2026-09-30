import { OcrApiSettingsSchema } from "@crawl-automation/processing";
import { describe, expect, it, vi } from "vitest";
import { FleetOcrHealth } from "./fleet-ocr.js";

const settings = OcrApiSettingsSchema.parse({
  baseUrl: "https://ocr.example.test",
  provider: "paddle/1",
  timeoutMs: 100,
});
const healthy = { status: "ok", healthy_backends: 4, total_backends: 4 };

describe("fleet OCR health", () => {
  it("GETs only /health using the existing OCR settings and an abort signal", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(healthy));
    const result = await new FleetOcrHealth(settings, transport).health();
    expect(transport).toHaveBeenCalledWith("https://ocr.example.test/health", {
      method: "GET",
      signal: expect.any(AbortSignal),
      redirect: "error",
    });
    expect(result).toEqual({
      configured: true,
      healthy: true,
      statusCode: 200,
      body: healthy,
      error: null,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("does not call an endpoint when OCR is unconfigured", async () => {
    const transport = vi.fn<typeof fetch>();
    expect(await new FleetOcrHealth(undefined, transport).health()).toMatchObject({
      configured: false,
      healthy: false,
      statusCode: null,
      body: null,
      error: null,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [503, healthy],
    [200, { ...healthy, status: "degraded" }],
    [200, { ...healthy, healthy_backends: 2 }],
    [200, { ...healthy, healthy_backends: 0, total_backends: 0 }],
    [200, {}],
  ])("does not turn an unhealthy response into success: %s %j", async (status, body) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
    const result = await new FleetOcrHealth(settings, transport).health();
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(status);
    expect(result.body).toEqual(body);
  });

  it("records malformed JSON while retaining the observed HTTP status", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>error</html>"));
    const result = await new FleetOcrHealth(settings, transport).health();
    expect(result).toMatchObject({ healthy: false, statusCode: 200, body: null });
    expect(result.error?.message).toBeTruthy();
  });

  it("reports unreachable OCR without a second request", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    expect(await new FleetOcrHealth(settings, transport).health()).toMatchObject({
      healthy: false,
      statusCode: null,
      error: { message: "fetch failed" },
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("aborts a stalled health request at the configured timeout", async () => {
    const transport = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const result = await new FleetOcrHealth(settings, transport).health();
    expect(result.healthy).toBe(false);
    expect(result.error?.message).toBeTruthy();
    expect(transport).toHaveBeenCalledOnce();
  });
});
