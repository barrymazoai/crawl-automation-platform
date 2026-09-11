import { describe, expect, it, vi } from "vitest";
import { ScraperApiTransport } from "./scraperapi.js";
import { createHttpRoute, requireCapability } from "./routes.js";
import type { Response } from "./ports.js";
const selection = { routeId: "scraper-us", version: "1", egressId: "scraper/us-1", mode: "scraperapi", managed: true,
  countryCode: "us", sessionNumber: 42, responseMode: "html", providerPolicy: "scraperapi-sync/1" };
const privateConfig = { apiKey: "test_only_canary_NOT_A_KEY", allowedOrigins: ["https://www.swansonvitamins.com"] };
const target = new URL("https://www.swansonvitamins.com/products/example?premium=true&country_code=gb&x=a%26b");
const signal = () => new AbortController().signal;
const response = (status = 200): Response => ({ status, headers: { "content-type": "text/html", "set-cookie": "private-cookie", "sa-credit-cost": "1" },
  body: (async function* () { yield Buffer.from("<html>fixture</html>"); })(), close: vi.fn() });
describe("ScraperAPI explicit, single-submission transport (no live calls)", () => {
  it("encodes the entire target, sends provider parameters separately, never forwards credentials", async () => {
    const res = response(), send = vi.fn(async () => res), transport = new ScraperApiTransport(selection, privateConfig, send);
    const result = await transport.get(target, undefined, { accept: "text/html" }, signal());
    const url = (send.mock.calls[0] as unknown as [URL])[0];
    expect(url.origin).toBe("https://api.scraperapi.com"); expect(url.searchParams.get("url")).toBe(target.href);
    expect(url.searchParams.get("country_code")).toBe("us"); expect(url.searchParams.has("premium")).toBe(false);
    expect(url.searchParams.get("session_number")).toBe("42"); expect(url.searchParams.get("follow_redirect")).toBe("false");
    expect([...url.searchParams.keys()].at(-1)).toBe("url"); expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(transport)).not.toContain(privateConfig.apiKey); expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["sa-credit-cost"]).toBeUndefined();
    const chunks = []; for await (const chunk of result.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("<html>fixture</html>"); expect(res.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["html", ["http"], null, null], ["rendered-html", ["http", "rendered-html"], "true", null], ["binary", ["http", "binary"], null, "true"],
  ])("%s capability is explicit and not an interactive browser", async (mode, capabilities, render, binary) => {
    const send = vi.fn(async () => response());
    const transport = new ScraperApiTransport({ ...selection, responseMode: mode, sessionNumber: null }, privateConfig, send);
    expect(transport.capabilities).toEqual(capabilities);
    const res = await transport.get(target, undefined, {}, signal()); res.close();
    const url = (send.mock.calls[0] as unknown as [URL])[0];
    expect(url.searchParams.get("render")).toBe(render); expect(url.searchParams.get("binary_target")).toBe(binary);
    expect(url.searchParams.has("session_number")).toBe(false);
    expect(() => requireCapability({ selection: transport.selection, transport, capabilities: transport.capabilities }, "interactive-browser")).toThrow("NETWORK.CAPABILITY_UNAVAILABLE");
  });
  it("factory requires private provider configuration and rejects incompatible options", () => {
    expect(() => createHttpRoute(selection)).toThrow("NETWORK.CONFIG_INVALID");
    const route = createHttpRoute(selection, { scraperApi: privateConfig });
    expect(route.transport).toBeInstanceOf(ScraperApiTransport); expect(route.transport.targetResolution).toBe("proxy");
    expect(() => createHttpRoute(selection, { scraperApi: privateConfig, proxyUrl: "http://localhost:7890" })).toThrow("NETWORK.CONFIG_INVALID");
    expect(() => createHttpRoute({ routeId: "direct", version: "1", egressId: "direct/1", mode: "direct", managed: true }, { scraperApi: privateConfig })).toThrow("NETWORK.CONFIG_INVALID");
  });
  it.each([
    { ...selection, apiKey: privateConfig.apiKey }, { ...selection, premium: true }, { ...selection, countryCode: "USA" },
    { ...selection, responseMode: "interactive-browser" }, { ...selection, sessionNumber: -1 }, { ...selection, managed: false },
  ])("rejects unsupported public options", route => { expect(() => new ScraperApiTransport(route, privateConfig)).toThrow(/^SCRAPERAPI.CONFIG_INVALID$/); });
  it.each(["https://127.0.0.1", "http://www.swansonvitamins.com", "https://www.swansonvitamins.com/path", "https://user:secret@www.swansonvitamins.com"])("rejects invalid origins: %s", origin => {
    expect(() => new ScraperApiTransport(selection, { ...privateConfig, allowedOrigins: [origin] })).toThrow(/^SCRAPERAPI.CONFIG_INVALID$/);
  });
  it("blocks non-allowlisted targets and cookie/auth/pinned-address requests before sending", async () => {
    const send = vi.fn(), transport = new ScraperApiTransport(selection, privateConfig, send);
    for (const url of ["https://evil.example/", "https://127.0.0.1/", "https://u:p@www.swansonvitamins.com/", "https://www.swansonvitamins.com/#x"])
      await expect(transport.get(new URL(url), undefined, {}, signal())).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
    for (const headers of [{ cookie: "x" }, { authorization: "Bearer x" }, { accept: "x\r\ny" }])
      await expect(transport.get(target, undefined, headers, signal())).rejects.toThrow("SCRAPERAPI.CONFIG_INVALID");
    await expect(transport.get(target, { address: "8.8.8.8", family: 4 }, {}, signal())).rejects.toThrow("SCRAPERAPI.CONFIG_INVALID");
    expect(send).not.toHaveBeenCalled();
  });
  it.each([[401, "AUTH"], [403, "PROVIDER_FAILURE"], [429, "THROTTLED"], [500, "PROVIDER_FAILURE"], [302, "REDIRECT_UNVERIFIED"]])("status %s is one failed submission, not a session rotation", async (status, code) => {
    const res = response(Number(status)), send = vi.fn(async () => res), transport = new ScraperApiTransport(selection, privateConfig, send);
    await expect(transport.get(target, undefined, {}, signal())).rejects.toThrow(`SCRAPERAPI.${code}`);
    expect(send).toHaveBeenCalledTimes(1); expect(res.close).toHaveBeenCalledTimes(1); expect(transport.selection.sessionNumber).toBe(42);
  });
  it.each([404, 410])("retains %s as HTTP evidence, not a product absence decision", async status => {
    const transport = new ScraperApiTransport(selection, privateConfig, async () => response(status));
    const res = await transport.get(target, undefined, {}, signal()); expect(res.status).toBe(status); res.close();
  });
  it("rejects a changed final URL without following it", async () => {
    const res = response(); res.headers["sa-final-url"] = "https://evil.example/";
    const send = vi.fn(async () => res), transport = new ScraperApiTransport(selection, privateConfig, send);
    await expect(transport.get(target, undefined, {}, signal())).rejects.toThrow("SCRAPERAPI.REDIRECT_UNVERIFIED"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("redacts provider exceptions", async () => {
    const transport = new ScraperApiTransport(selection, privateConfig, async () => { throw Error(`https://api.scraperapi.com/?api_key=${privateConfig.apiKey}`); });
    await expect(transport.get(target, undefined, {}, signal())).rejects.toThrow(/^SCRAPERAPI.EXECUTION_UNKNOWN$/);
  });
  it("aborts a stuck request and closes a late response without resubmission", async () => {
    let finish!: (r: Response) => void;
    const send = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })), controller = new AbortController();
    const transport = new ScraperApiTransport(selection, privateConfig, send), pending = transport.get(target, undefined, {}, controller.signal);
    const check = expect(pending).rejects.toThrow("SCRAPERAPI.EXECUTION_UNKNOWN"); controller.abort(); await check;
    const late = response(); finish(late); await Promise.resolve(); expect(late.close).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  });
  it("aborts a stuck body iterator and closes only once", async () => {
    const res = response(); res.body = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) };
    const controller = new AbortController(), transport = new ScraperApiTransport(selection, privateConfig, async () => res);
    const result = await transport.get(target, undefined, {}, controller.signal);
    const pending = result.body[Symbol.asyncIterator]().next(), check = expect(pending).rejects.toThrow("SCRAPERAPI.EXECUTION_UNKNOWN");
    controller.abort(); await check; result.close(); expect(res.close).toHaveBeenCalledTimes(1);
  });
  it("redacts a body error and closes on early consumption stop", async () => {
    const res = response(); res.body = (async function* () { throw Error(privateConfig.apiKey); yield Buffer.alloc(0); })();
    const transport = new ScraperApiTransport(selection, privateConfig, async () => res);
    const result = await transport.get(target, undefined, {}, signal());
    await expect(result.body[Symbol.asyncIterator]().next()).rejects.toThrow(/^SCRAPERAPI.EXECUTION_UNKNOWN$/); expect(res.close).toHaveBeenCalledTimes(1);
    const second = response(), t2 = new ScraperApiTransport(selection, privateConfig, async () => second);
    const r2 = await t2.get(target, undefined, {}, signal()); for await (const _ of r2.body) break;
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
