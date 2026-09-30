import { ScraperApiClient, scraperApiErrors } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { singleRequestClient } from "./single-request-client.js";

describe("one paid request capability", () => {
  it("refuses the current redirect-following client before any network request", () => {
    const client = new ScraperApiClient({
      apiKey: "test-key-0000",
      allowedOrigins: ["https://page.test"],
    });
    const get = vi.spyOn(client, "get");
    expect(() => singleRequestClient(client)).toThrow(
      expect.objectContaining({
        code: "EVIDENCE.SINGLE_REQUEST_UNAVAILABLE",
      }),
    );
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
