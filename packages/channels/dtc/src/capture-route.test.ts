import { expect, it, vi } from "vitest";
import { DtcPlatformCapture } from "./capture-route.js";
import { dtcSitePolicy } from "./site-policy.js";

it("sends a custom store product directly to agent capture without reading its page", async () => {
  const site = dtcSitePolicy({
    siteKey: "www.dherbs.com",
    platform: "custom",
    catalogUrl: "https://www.dherbs.com/store/",
  });
  const pages = { fetchPage: vi.fn() };
  const captured = { route: "agent" };
  const agent = { capture: vi.fn(async () => captured) };
  const onDecision = vi.fn();
  const route = new DtcPlatformCapture({
    pages,
    agent,
    sites: [site],
    onDecision,
  } as unknown as ConstructorParameters<typeof DtcPlatformCapture>[0]);
  const request = {
    operationId: "product-1",
    url: "https://www.dherbs.com/featured/full-body-cleanse/",
  };
  expect(
    await route.capture(
      request as Parameters<typeof route.capture>[0],
      new AbortController().signal,
    ),
  ).toBe(captured);
  expect(agent.capture).toHaveBeenCalledOnce();
  expect(pages.fetchPage).not.toHaveBeenCalled();
  expect(onDecision).toHaveBeenCalledWith({
    route: "agent",
    site: "www.dherbs.com",
    reason: "site_policy",
    url: request.url,
    operationId: request.operationId,
  });
});
