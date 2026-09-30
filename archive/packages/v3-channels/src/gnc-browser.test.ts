import { describe, it, expect, vi } from "vitest";
import type { GncCaptureInput } from "@crawl-automation/v3-contracts";
import type { RenderedBrowser, RenderedPage } from "@crawl-automation/v3-acquisition";
import { GncBrowserReader } from "./gnc-browser.js";
import { GncAdapter, type GncReceivedPage } from "./gnc.js";
const input: GncCaptureInput = { kind: "product", requestId: "r", operationId: "op", brandId: "b", sourceId: "gnc", sku: "123456", url: "https://www.gnc.com/123456.html", binding: { sessionId: "s", egressId: "host/1" } };
const network = { mode: "host", managed: false, routeId: "chrome", version: "browser-1", egressId: "host/1" } as const;
const html = '<script type="application/ld+json">{"@type":"Product","sku":"123456","name":"Vitamin"}</script><div id="productIngredientsAccordionContent">Other ingredients: Water</div>';
const signal = () => new AbortController().signal;
function fixture() {
  const page: RenderedPage = { url: input.url, html, status: 200, contentType: "text/html", browserId: "instance", targetId: "owned" };
  const read = vi.fn(async () => page), browser: RenderedBrowser = { sessionId: "s", egressId: "host/1", read };
  const grant = { input: structuredClone(input), expiresAt: "2099-01-01T00:00:00Z" };
  return { page, read, browser, grant, reader: new GncBrowserReader(network, browser, [grant]) };
}
describe("GNC browser-only reader", () => {
  it("passes rendered DOM to the existing SKU parser and preserves route identity", async () => {
    const f = fixture(), result = await new GncAdapter(f.reader).capture(input, signal());
    expect(result.data).toMatchObject({ sku: "123456", factsHtml: expect.stringContaining("Water") });
    expect(result.network).toEqual(network); expect(f.read).toHaveBeenCalledTimes(1);
    expect(result.artifactDurable).toBe(false);
  });
  it("rejects other operation/Brand/session before opening a browser tab", async () => {
    const f = fixture();
    for (const patch of [{ operationId: "other" }, { brandId: "other" }, { binding: { sessionId: "other", egressId: "host/1" } }])
      await expect(f.reader.read({ ...input, ...patch }, signal())).rejects.toThrow("GNC.SESSION_CONFLICT");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("does not accept mixed browser sessions or duplicate grants", () => {
    const f = fixture();
    expect(() => new GncBrowserReader(network, { ...f.browser, sessionId: "wrong" }, [f.grant])).toThrow("GNC.SESSION_CONFLICT");
    expect(() => new GncBrowserReader(network, f.browser, [f.grant, f.grant])).toThrow("GNC.SESSION_CONFLICT");
  });
  it("snapshots grants; rejects expiry before and after navigation", async () => {
    const f = fixture(); f.grant.input.brandId = "changed";
    await f.reader.read(input, signal());
    const expired = new GncBrowserReader(network, f.browser, [{ input, expiresAt: "2000-01-01T00:00:00Z" }]);
    await expect(expired.read(input, signal())).rejects.toThrow("GNC.SESSION_EXPIRED");
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each([[406, "GNC.ACCESS_CHALLENGE"], [404, "GNC.NOT_FOUND"], [0, "GNC.HTTP_STATUS"]])("browser HTTP %s is not a complete product", async (status, code) => {
    const f = fixture(); f.page.status = Number(status);
    await expect(new GncAdapter(f.reader).capture(input, signal())).rejects.toThrow(String(code));
  });
  it("retains a rendered 307 human-verification page before classifying it, with one browser read", async () => {
    const f = fixture(); f.page.status = 307;
    f.page.html = '<html><title>Access to this page has been denied</title><body>Press &amp; Hold to confirm you are a human.</body></html>';
    const retain = vi.fn(async (_page: GncReceivedPage) => {});
    await expect(new GncAdapter(f.reader).capture(input, signal(), retain)).rejects.toThrow("GNC.ACCESS_CHALLENGE");
    expect(retain).toHaveBeenCalledTimes(1);
    expect(Buffer.from(retain.mock.calls[0]![0]!.html).toString()).toBe(f.page.html);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("rejects redirected DOM, and never uses raw HTTP as a fallback", async () => {
    const f = fixture(); f.page.url = "https://www.gnc.com/other.html";
    await expect(new GncAdapter(f.reader).capture(input, signal())).rejects.toThrow("GNC.REDIRECT_UNVERIFIED");
    f.read.mockRejectedValue(new Error("SOURCE.BROWSER_NAVIGATION"));
    await expect(f.reader.read(input, signal())).rejects.toThrow("SOURCE.BROWSER_NAVIGATION");
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("cancellation does not retry or navigate again", async () => {
    const f = fixture(), c = new AbortController(); c.abort(new Error("cancelled"));
    await expect(f.reader.read(input, c.signal)).rejects.toThrow("cancelled"); expect(f.read).not.toHaveBeenCalled();
  });
});
