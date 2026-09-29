import { describe, expect, it } from "vitest";
import { WorkerConfigSchema } from "./config.js";

const capture = WorkerConfigSchema.shape.capture;
const route = {
  routeId: "scraperapi-us",
  version: "scraperapi/1",
  egressId: "scraperapi-us/1",
  mode: "scraperapi",
  managed: true,
  countryCode: "us",
  sessionNumber: null,
  responseMode: "html",
  providerPolicy: "scraperapi-sync/1",
};
const scraperApi = {
  apiKey: "test_only_canary_NOT_A_KEY",
  allowedOrigins: ["https://www.swansonvitamins.com", "https://www.gnc.com"],
};

describe("worker capture settings", () => {
  it("still reads the 2026-09-29 settings, with no channel options", () => {
    expect(capture.parse({ route, scraperApi })).toMatchObject({ channels: {} });
  });

  it("reads a channel's own ScraperAPI options", () => {
    const parsed = capture.parse({ route, scraperApi, channels: { gnc: { premium: true } } });
    expect(parsed.channels).toEqual({ gnc: { premium: true } });
  });

  it.each([
    { route: { ...route, responseMode: "binary" }, scraperApi },
    { route, scraperApi, channels: { gnc: { ultraPremium: true } } },
    { route, scraperApi, channels: { walmart: { premium: true } } },
    { route, scraperApi: { ...scraperApi, allowedOrigins: ["http://www.gnc.com"] } },
  ])("refuses settings a page fetch cannot use: %j", (settings) => {
    expect(capture.safeParse(settings).success).toBe(false);
  });
});
