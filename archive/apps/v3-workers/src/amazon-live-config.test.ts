import { describe, expect, it } from "vitest";
import { AmazonCaptureConfigSchema, amazonCaptureIssues } from "./amazon-live-config.js";

const lane = (id: string) => ({ activities: { readCatalogPage: [{ resourceId: id }], browserSession: [{ resourceId: id }] } });
const route = { routeId: "route-us", version: "scraperapi/1", egressId: "scraperapi-us/1", mode: "scraperapi" as const, managed: true as const,
  countryCode: "us", sessionNumber: null, responseMode: "html" as const, providerPolicy: "scraperapi-sync/1" as const };
const scraperApi = { apiKey: "fake-key-000000", allowedOrigins: ["https://www.amazon.com"] };

describe("Amazon capture configuration", () => {
  it("defaults to browser mode and keeps the existing browser requirements", () => {
    expect(AmazonCaptureConfigSchema.parse({ mode: "browser" })).toEqual({ mode: "browser" });
    expect(amazonCaptureIssues({ capture: { mode: "browser" }, browser: { engine: "ego-lite" }, browserResource: "mini-ego-space-1", egressId: "ego/1",
      catalogResources: lane("mini-ego-space-1"), productResources: lane("mini-ego-space-1") })).toEqual([]);
    expect(amazonCaptureIssues({ capture: { mode: "browser" }, browserResource: "mini-ego-space-1", egressId: "ego/1",
      catalogResources: lane("other"), productResources: lane("mini-ego-space-1") })).toEqual(["Browser capture requires an owned browser task space", "Shared browser admission and label core queue required"]);
  });
  it("scraperapi mode needs an html route, direct image egress, the Amazon origin and no pinned postal code", () => {
    const capture = AmazonCaptureConfigSchema.parse({ mode: "scraperapi", route, scraperApi });
    expect(capture).toMatchObject({ mode: "scraperapi", images: "direct" });
    const base = { capture, browserResource: "scraperapi-us", egressId: "direct/1", catalogResources: { activities: {} }, productResources: { ...lane("scraperapi-us"), releaseOnReview: true } };
    expect(amazonCaptureIssues(base)).toEqual([]);
    expect(amazonCaptureIssues({ ...base, productResources: lane("scraperapi-us") })).toEqual(["ScraperAPI capture lane must release on Review (releaseOnReview)"]);
    expect(amazonCaptureIssues({ ...base, deliveryPostalCode: "10001" })).toEqual(["ScraperAPI capture cannot pin a delivery postal code"]);
    expect(amazonCaptureIssues({ ...base, egressId: "ego/1" })).toEqual(["Direct image downloads require egressId direct/1"]);
    const rendered = AmazonCaptureConfigSchema.parse({ mode: "scraperapi", route: { ...route, responseMode: "rendered-html" }, scraperApi });
    expect(amazonCaptureIssues({ ...base, capture: rendered })).toEqual(["ScraperAPI capture reads static HTML only"]);
    const foreign = AmazonCaptureConfigSchema.parse({ mode: "scraperapi", route, scraperApi: { ...scraperApi, allowedOrigins: ["https://www.amazon.co.jp"] } });
    expect(amazonCaptureIssues({ ...base, capture: foreign })).toEqual(["ScraperAPI route must allow https://www.amazon.com"]);
    expect(amazonCaptureIssues({ ...base, productResources: { ...lane("mini-ego-space-1"), releaseOnReview: true } })).toEqual(["Product admission must include the capture lane resource"]);
    expect(AmazonCaptureConfigSchema.safeParse({ mode: "scraperapi", route, scraperApi: { ...scraperApi, apiKey: "bad key!" } }).success).toBe(false);
  });
});
