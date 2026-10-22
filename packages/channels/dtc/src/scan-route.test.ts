import { brandScanErrors, platformPageErrors } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import { dtcBrandSource } from "./brand-source.js";
import type { DtcBrandScanResult } from "./brand-scan.js";
import { DtcScanRoute } from "./scan-route.js";
import { dtcSitePolicy } from "./site-policy.js";

const shopify = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "shopify",
  catalogUrl: "https://shop.example/collections/all",
});
const agentSite = dtcSitePolicy({
  siteKey: "custom.example",
  platform: "jsonld",
  catalogUrl: "https://custom.example/catalog",
});

function result(sourceUrl: string, archiveKey: string): DtcBrandScanResult {
  return {
    sourceUrl,
    source: dtcBrandSource(sourceUrl, [shopify, agentSite]),
    pages: [{ products: [], cards: 0, nextPage: null, statedTotal: null }],
    complete: true,
    soldHere: true,
    archiveKeys: [archiveKey],
    stopped: "end",
  };
}

function setup() {
  const platform = {
    scan: vi.fn(async (request: { sourceUrl: string }) => result(request.sourceUrl, "ego")),
  };
  const agent = {
    scan: vi.fn(async (request: { sourceUrl: string }) => result(request.sourceUrl, "agent")),
  };
  const onDecision = vi.fn();
  const route = new DtcScanRoute({ platform, agent, sites: [shopify, agentSite], onDecision });
  return { route, platform, agent, onDecision };
}

const signal = () => new AbortController().signal;
const request = (sourceUrl: string) => ({ scanId: "scan-1", sourceUrl });

describe("DTC brand scan route", () => {
  it("replays a platform site's catalog in Ego and preserves its scan result", async () => {
    const { route, platform, agent, onDecision } = setup();
    const input = request(shopify.catalogUrl ?? "");
    const found = await route.scan(input, signal());
    expect(found).toEqual(result(input.sourceUrl, "ego"));
    expect(platform.scan).toHaveBeenCalledOnce();
    expect(agent.scan).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith({
      route: "platform",
      site: shopify.siteKey,
      sourceUrl: input.sourceUrl,
      scanId: input.scanId,
    });
  });

  it("keeps an agent site's recorded catalog method", async () => {
    const { route, platform, agent, onDecision } = setup();
    const input = request(agentSite.catalogUrl ?? "");
    expect(await route.scan(input, signal())).toEqual(result(input.sourceUrl, "agent"));
    expect(platform.scan).not.toHaveBeenCalled();
    expect(agent.scan).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith({
      route: "agent",
      site: agentSite.siteKey,
      reason: "site_policy",
      sourceUrl: input.sourceUrl,
      scanId: input.scanId,
    });
  });

  it.each([platformPageErrors.create("DTC.PLATFORM_UNVERIFIED")])(
    "falls back to the agent only for an unverified platform: %s",
    async (error) => {
      const { route, platform, agent, onDecision } = setup();
      platform.scan.mockRejectedValueOnce(error);
      const input = request(shopify.catalogUrl ?? "");
      expect(await route.scan(input, signal())).toEqual(result(input.sourceUrl, "agent"));
      expect(agent.scan).toHaveBeenCalledOnce();
      expect(onDecision).toHaveBeenLastCalledWith({
        route: "agent",
        site: shopify.siteKey,
        reason: error.code,
        sourceUrl: input.sourceUrl,
        scanId: input.scanId,
      });
    },
  );

  it.each([
    brandScanErrors.create("BRAND_SCAN.CANCELLED"),
    brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED"),
    brandScanErrors.create("BRAND_SCAN.PAGINATION"),
    platformPageErrors.create("DTC.PAGE_LIMIT"),
    platformPageErrors.create("DTC.CATALOG_JSON_INVALID"),
    platformPageErrors.create("DTC.CATALOG_HTTP_STATUS"),
    platformPageErrors.create("DTC.CATALOG_READY_TIMEOUT"),
    platformPageErrors.create("DTC.CATALOG_SCOPE_REQUIRED"),
    platformPageErrors.create("DTC.LISTING_UNVERIFIED"),
    new Error("browser transport failed"),
  ])("does not retry cancellation, archive, size, or transport failures: %s", async (error) => {
    const { route, platform, agent } = setup();
    platform.scan.mockRejectedValueOnce(error);
    await expect(route.scan(request(shopify.catalogUrl ?? ""), signal())).rejects.toBe(error);
    expect(agent.scan).not.toHaveBeenCalled();
  });

  it("does not fall back after an abort even if the page reports a shape error", async () => {
    const { route, platform, agent } = setup();
    const controller = new AbortController();
    platform.scan.mockImplementationOnce(async () => {
      controller.abort();
      throw platformPageErrors.create("DTC.LISTING_UNVERIFIED");
    });
    await expect(
      route.scan(request(shopify.catalogUrl ?? ""), controller.signal),
    ).rejects.toMatchObject({
      code: "DTC.LISTING_UNVERIFIED",
    });
    expect(agent.scan).not.toHaveBeenCalled();
  });
});
