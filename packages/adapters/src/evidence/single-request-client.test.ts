import { ScraperApiClient, scraperApiErrors } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { singleRequestClient } from "./single-request-client.js";

describe("one paid request capability", () => {
  it("binds the real client's single-request method to the page-client interface", async () => {
    const client = new ScraperApiClient({
      apiKey: "test-key-0000",
      allowedOrigins: ["https://page.test"],
    });
    const get = vi.spyOn(client, "get");
    const page = {
      status: 200,
      url: "https://page.test/product",
      contentType: "text/html",
      contentEncoding: null,
      bytes: Buffer.from("<html>page</html>"),
      creditCost: 1,
    };
    const getOnce = vi.spyOn(client, "getOnce").mockResolvedValue(page);
    const request = {
      target: page.url,
      options: {},
      maxBytes: 1024,
      tooLarge: () => scraperApiErrors.create("SCRAPERAPI.PROVIDER_FAILURE"),
    };
    const signal = new AbortController().signal;
    const single = singleRequestClient(client);
    await expect(single.get(request, signal)).resolves.toBe(page);
    expect(single.provider).toBe(client.provider);
    expect(getOnce).toHaveBeenCalledExactlyOnceWith(request, signal);
    expect(getOnce.mock.contexts).toEqual([client]);
    expect(get).not.toHaveBeenCalled();
  });

  it("calls the single-request capability once and preserves its failure", async () => {
    const failure = scraperApiErrors.create("SCRAPERAPI.REDIRECT_UNVERIFIED");
    const getOnce = vi.fn().mockRejectedValue(failure);
    const client = { provider: "scraperapi-sync/1" as const, get: vi.fn(), getOnce };
    const single = singleRequestClient(client);
    await expect(
      single.get(
        {
          target: "https://page.test/product",
          options: {},
          maxBytes: 1024,
          tooLarge: () => scraperApiErrors.create("SCRAPERAPI.PROVIDER_FAILURE"),
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(getOnce).toHaveBeenCalledTimes(1);
    expect(client.get).not.toHaveBeenCalled();
  });
});
