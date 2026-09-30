import { describe, expect, it, vi } from "vitest";
import { NetworkRouteSchema } from "@crawl-automation/v3-contracts";
import { createHttpRoute, requireCapability } from "./routes.js";
import { StaticProxyTransport } from "./proxy.js";
const base = { routeId: "route-1", version: "1", egressId: "lane/1" };
describe("explicit HTTP route selection", () => {
  it("unmanaged requires an existing host client, not a new DIRECT fallback", () => {
    const selection = { ...base, mode: "host", managed: false };
    expect(() => createHttpRoute(selection)).toThrow("NETWORK.HOST_CLIENT_REQUIRED");
    const client = { egressId: base.egressId, get: vi.fn() };
    const route = createHttpRoute(selection, { hostClient: client });
    expect(route.transport).toBe(client); expect(client.get).not.toHaveBeenCalled();
    expect(() => requireCapability(route, "rendered-html")).toThrow("NETWORK.CAPABILITY_UNAVAILABLE");
    expect(() => requireCapability(route, "interactive-browser")).toThrow("NETWORK.CAPABILITY_UNAVAILABLE");
  });
  it("DIRECT must be explicitly selected; route mismatch is fatal", () => {
    expect(createHttpRoute({ ...base, mode: "direct", managed: true, egressId: "direct/1" }).transport.egressId).toBe("direct/1");
    expect(() => createHttpRoute({ ...base, mode: "host", managed: false }, { hostClient: { egressId: "other", get: vi.fn() } })).toThrow("NETWORK.ROUTE_MISMATCH");
  });
  it("static proxy metadata contains no private endpoint; independent instances", () => {
    const first = createHttpRoute({ ...base, mode: "static-proxy", managed: true }, { proxyUrl: "http://u:canary@127.0.0.1:1234" });
    const second = createHttpRoute({ ...base, egressId: "lane/2", mode: "static-proxy", managed: true }, { proxyUrl: "http://127.0.0.1:4321" });
    expect(first.transport).not.toBe(second.transport);
    expect(JSON.stringify(first)).not.toContain("canary");
    expect(Object.isFrozen(first.selection)).toBe(true);
  });
  it.each([
    { ...base, mode: "host", managed: true }, { ...base, mode: "direct", managed: false },
    { ...base, mode: "static-proxy", managed: true, proxyUrl: "https://secret" },
    { ...base, mode: "scraperapi", managed: true },
  ])("rejects unsupported or secret-bearing public config: %j", config => {
    expect(NetworkRouteSchema.safeParse(config).success).toBe(false);
    expect(() => createHttpRoute(config)).toThrow("NETWORK.CONFIG_INVALID");
  });
  it.each(["socks5://localhost:7890", "https://proxy.test/path", "https://proxy.test/?key=x", "http://u:password@proxy.test", "invalid"])("rejects unsafe/unsupported proxy configuration without leaking it", proxy => {
    expect(() => new StaticProxyTransport("lane/1", proxy)).toThrow(/^NETWORK.CONFIG_INVALID$/);
  });
  it("rejects IP literals, old pinned callers and header overrides before connecting", async () => {
    const transport = new StaticProxyTransport("lane/1", "http://127.0.0.1:1");
    expect(transport.targetResolution).toBe("proxy");
    await expect(transport.get(new URL("https://127.0.0.1/a"), undefined, {}, new AbortController().signal)).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
    await expect(transport.get(new URL("https://www.gnc.com/a"), { address: "8.8.8.8", family: 4 }, {}, new AbortController().signal)).rejects.toThrow("NETWORK.CONFIG_INVALID");
    for (const headers of [{ "Proxy-Authorization": "secret" }, { cookie: "x\r\nx: y" }, { cookie: "中文" }, { cookie: "\u0001" }, { Host: "evil" }])
      await expect(transport.get(new URL("https://www.gnc.com/a"), undefined, headers, new AbortController().signal)).rejects.toThrow("NETWORK.CONFIG_INVALID");
  });
});
