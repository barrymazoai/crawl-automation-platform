import { NetworkRouteSchema, type NetworkCapability, type NetworkRoute } from "@crawl-automation/v3-contracts";
import { DirectHttpsTransport } from "./network.js";
import { NetworkError, StaticProxyTransport } from "./proxy.js";
import type { FileTransport } from "./ports.js";
import { ScraperApiTransport } from "./scraperapi.js";

export interface HttpRoute {
  readonly selection: NetworkRoute;
  readonly capabilities: readonly NetworkCapability[];
  readonly transport: FileTransport;
}
/** Host client is already configured by its owning runtime, including any host/browser proxy semantics.
 * Merely turning management off cannot create a DIRECT client. No global proxy settings are read or written.
 */
export function createHttpRoute(raw: unknown, privateConfig: { proxyUrl?: string; hostClient?: FileTransport; scraperApi?: { apiKey: string; allowedOrigins: string[] } } = {}): HttpRoute {
  const parsed = NetworkRouteSchema.safeParse(raw);
  if (!parsed.success) throw new NetworkError("NETWORK.CONFIG_INVALID");
  const selection = Object.freeze(parsed.data);
  if (selection.mode !== "scraperapi" && privateConfig.scraperApi) throw new NetworkError("NETWORK.CONFIG_INVALID");
  let transport: FileTransport;
  switch (selection.mode) {
    case "host":
      if (privateConfig.proxyUrl) throw new NetworkError("NETWORK.CONFIG_INVALID");
      if (!privateConfig.hostClient) throw new NetworkError("NETWORK.HOST_CLIENT_REQUIRED");
      transport = privateConfig.hostClient;
      break;
    case "direct":
      if (privateConfig.proxyUrl || privateConfig.hostClient) throw new NetworkError("NETWORK.CONFIG_INVALID");
      transport = new DirectHttpsTransport();
      break;
    case "static-proxy":
      if (!privateConfig.proxyUrl || privateConfig.hostClient) throw new NetworkError("NETWORK.CONFIG_INVALID");
      transport = new StaticProxyTransport(selection.egressId, privateConfig.proxyUrl);
      break;
    case "scraperapi":
      if (privateConfig.proxyUrl || privateConfig.hostClient || !privateConfig.scraperApi) throw new NetworkError("NETWORK.CONFIG_INVALID");
      transport = new ScraperApiTransport(selection, privateConfig.scraperApi);
      break;
  }
  if (transport.egressId !== selection.egressId) throw new NetworkError("NETWORK.ROUTE_MISMATCH");
  return Object.freeze({ selection, transport, capabilities: transport instanceof ScraperApiTransport ? transport.capabilities : Object.freeze(["http", "binary"] as const) });
}
export function requireCapability(route: HttpRoute, required: NetworkCapability): void {
  if (!route.capabilities.includes(required)) throw new NetworkError("NETWORK.CAPABILITY_UNAVAILABLE");
  if (route.selection.egressId !== route.transport.egressId) throw new NetworkError("NETWORK.ROUTE_MISMATCH");
}
