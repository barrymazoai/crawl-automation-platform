import { expect, it, vi } from "vitest";
import {
  RetainedPublication,
  type ObjectStore,
  type BrowserPage,
  type BrowserRead,
} from "@crawl-automation/platform";
import { SiteAnalysisPages } from "./pages.js";
function memory(): ObjectStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, Uint8Array.from(bytes));
      return "created";
    },
  };
}
function setup(maxPages = 10) {
  const remote = memory();
  const evidence = vi.fn(async (key: string) => {
    expect(remote.data.has(key)).toBe(true);
  });
  const read = vi.fn(async (request: BrowserRead): Promise<BrowserPage> => ({
    url: request.url,
    html: "<html><body>é 🧪</body></html>",
    status: 200,
    ready: true,
    scroll: { rounds: 0, ended: "none" },
  }));
  const publication = new RetainedPublication(memory(), remote);
  const deps = {
    publication,
    browser: { read, provider: "ego-lite/2" },
    evidence,
    analysisId: "11111111-1111-4111-8111-111111111111",
    maxPages,
  };
  return { pages: new SiteAnalysisPages(deps), deps, read, evidence, remote };
}
it("returns only archived/read-back bytes, records evidence, and closes through the managed reader", async () => {
  const { pages, remote, read, evidence } = setup();
  const result = await pages.read("https://shop.example/products.json", AbortSignal.timeout(1000));
  expect(Buffer.from(remote.data.get(result.archiveKey) ?? []).toString()).toBe(result.html);
  expect(evidence).toHaveBeenCalledWith(result.archiveKey);
  expect(await pages.read("https://shop.example/products.json", AbortSignal.timeout(1000))).toEqual(
    result,
  );
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0].readySelector).toBe("body");
});
it("never refetches a failed attempt, including from a new reader instance", async () => {
  const { pages, read, deps } = setup();
  read.mockRejectedValueOnce(new Error("user control"));
  await expect(pages.read("https://shop.example/", AbortSignal.timeout(1000))).rejects.toThrow(
    "user control",
  );
  await expect(
    new SiteAnalysisPages(deps).read("https://shop.example/", AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: "CAPTURE.DOWNLOAD_UNRESOLVED" });
  expect(read).toHaveBeenCalledOnce();
});
it("retains an off-origin redirect as evidence but refuses to parse it", async () => {
  const { pages, read, evidence } = setup();
  read.mockResolvedValueOnce({
    url: "https://retailer.example/",
    html: "<html>retailer</html>",
    status: 200,
    ready: true,
    scroll: { ended: "none", rounds: 0 },
  });
  await expect(
    pages.read("https://shop.example/", AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: "DTC.ANALYSIS_REDIRECT" });
  expect(evidence).toHaveBeenCalledOnce();
});
it("stops at the global page budget before a new browser page opens", async () => {
  const { pages, read } = setup(1);
  await pages.read("https://shop.example/", AbortSignal.timeout(1000));
  await expect(
    pages.read("https://shop.example/products.json", AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: "DTC.ANALYSIS_LIMIT" });
  expect(read).toHaveBeenCalledOnce();
});
it("rejects corrupted archived bytes and never opens another page", async () => {
  const { pages, deps, remote, read } = setup();
  const result = await pages.read("https://shop.example/", AbortSignal.timeout(1000));
  remote.data.set(result.archiveKey, Buffer.from("bad"));
  await expect(
    new SiteAnalysisPages(deps).read("https://shop.example/", AbortSignal.timeout(1000)),
  ).rejects.toThrow();
  expect(read).toHaveBeenCalledOnce();
});
it("failed observations consume the budget and cannot be reinterpreted as ready pages", async () => {
  const { pages, read, evidence } = setup(1);
  read.mockResolvedValueOnce({
    url: "https://shop.example/",
    html: "<html>partial</html>",
    status: 200,
    ready: false,
    scroll: { ended: "none", rounds: 0 },
  });
  const signal = AbortSignal.timeout(1000);
  await expect(pages.read("https://shop.example/", signal)).rejects.toMatchObject({
    code: "DTC.ANALYSIS_UNVERIFIED",
  });
  await expect(pages.read("https://shop.example/", signal)).rejects.toMatchObject({
    code: "DTC.ANALYSIS_UNVERIFIED",
  });
  await expect(pages.read("https://shop.example/other", signal)).rejects.toMatchObject({
    code: "DTC.ANALYSIS_LIMIT",
  });
  expect(read).toHaveBeenCalledOnce();
  expect(evidence).toHaveBeenCalledOnce();
});
