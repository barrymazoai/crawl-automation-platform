import { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { platformErrors } from "../errors/platform-errors.js";
import { ScraperApiClient, type ScraperApiRequest } from "./scraperapi-client.js";

// Cases carried over from the previous ScraperAPI transport (v3-acquisition), run through undici's MockAgent.
const ORIGIN = "https://www.swansonvitamins.com";
const access = { apiKey: "test_only_canary_NOT_A_KEY", allowedOrigins: [ORIGIN] };
const target = `${ORIGIN}/products/example?premium=true&country_code=gb&x=a%26b`;
const signal = () => AbortSignal.timeout(5_000);
const tooLarge = () => platformErrors.create("CONFIG.TOO_LARGE");

interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A fake ScraperAPI: answers each call with the next reply and records every provider address it was asked for. */
function provider(...replies: Reply[]) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const calls: URL[] = [];
  const pool = agent.get("https://api.scraperapi.com");
  for (const reply of replies) {
    pool.intercept({ path: () => true, method: "GET" }).reply((options) => {
      calls.push(new URL(options.path, "https://api.scraperapi.com"));
      const headers = {
        "content-type": "text/html",
        "set-cookie": "private-cookie",
        ...reply.headers,
      };
      return {
        statusCode: reply.status,
        data: reply.body ?? "<html>page</html>",
        responseOptions: { headers },
      };
    });
  }
  const client = new ScraperApiClient(access, { dispatcher: agent });
  return { client, calls };
}

const request = (changes: Partial<ScraperApiRequest> = {}): ScraperApiRequest => ({
  target,
  options: {},
  maxBytes: 1_000_000,
  tooLarge,
  ...changes,
});

describe("ScraperAPI client", () => {
  it.each(["get", "getOnce"] as const)(
    "%s refuses a Shopify challenge without following or retrying the paid request",
    async (method) => {
      const address = `${ORIGIN}/collections/brand-now-foods/products.json?limit=250&page=1`;
      const location = `${address}&__shopify_bv_challenge=token`;
      const { client, calls } = provider({ status: 302, headers: { location } }, { status: 200 });
      await expect(client[method](request({ target: address }), signal())).rejects.toMatchObject({
        code: "SOURCE.ACCESS_CHALLENGE",
        details: { status: 302, target: address, location },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it.each(["__cf_chl_tk", "__cf_chl_rt_tk", "__cf_chl_f_tk"])(
    "classifies the provider's final URL marker %s as a challenge",
    async (marker) => {
      const { client, calls } = provider({
        status: 200,
        headers: { "sa-final-url": `${target}&${marker}=token` },
      });
      await expect(client.get(request(), signal())).rejects.toMatchObject({
        code: "SOURCE.ACCESS_CHALLENGE",
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("sends the whole page address last, the settings separately, and never the key anywhere else", async () => {
    const { client, calls } = provider({ status: 200, headers: { "sa-credit-cost": "5" } });
    const page = await client.get(request({ options: { sessionNumber: 42 } }), signal());
    const [call] = calls;
    expect(call?.searchParams.get("url")).toBe(target);
    expect([...(call?.searchParams.keys() ?? [])].at(-1)).toBe("url");
    expect(call?.searchParams.get("country_code")).toBe("us");
    expect(call?.searchParams.get("session_number")).toBe("42");
    expect(call?.searchParams.get("follow_redirect")).toBe("false");
    expect(call?.searchParams.has("premium")).toBe(false);
    expect(page).toMatchObject({
      status: 200,
      url: target,
      creditCost: 5,
      contentType: "text/html",
    });
    expect(page.bytes.toString()).toBe("<html>page</html>");
    expect(JSON.stringify([client, page])).not.toContain(access.apiKey);
    expect(JSON.stringify(page)).not.toContain("private-cookie");
  });

  it("asks for rendering, premium proxies and another country only when the options say so", async () => {
    const { client, calls } = provider({ status: 200 }, { status: 200 });
    await client.get(request(), signal());
    await client.get(
      request({ options: { render: true, premium: true, countryCode: "gb" } }),
      signal(),
    );
    expect(calls[0]?.searchParams.has("render")).toBe(false);
    expect(calls[0]?.searchParams.has("session_number")).toBe(false);
    expect(calls[1]?.searchParams.get("render")).toBe("true");
    expect(calls[1]?.searchParams.get("premium")).toBe("true");
    expect(calls[1]?.searchParams.get("country_code")).toBe("gb");
  });

  it.each([{ countryCode: "USA" }, { sessionNumber: -1 }, { binary: true }])(
    "refuses the options %j before any request",
    async (options) => {
      const { client, calls } = provider();
      await expect(client.get(request({ options }), signal())).rejects.toMatchObject({
        code: "SCRAPERAPI.CONFIG_INVALID",
      });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    "https://127.0.0.1",
    "http://www.swansonvitamins.com",
    `${ORIGIN}/path`,
    "https://u:p@example.com",
  ])("refuses the allowed site %s in its settings", (origin) => {
    expect(() => new ScraperApiClient({ ...access, allowedOrigins: [origin] })).toThrow(
      expect.objectContaining({ code: "SCRAPERAPI.CONFIG_INVALID" }),
    );
  });

  it.each([
    "https://evil.example/",
    "https://127.0.0.1/",
    `https://u:p@www.swansonvitamins.com/`,
    `${ORIGIN}/#x`,
  ])("never sends a page address off the allowed sites: %s", async (address) => {
    const { client, calls } = provider();
    await expect(client.get(request({ target: address }), signal())).rejects.toMatchObject({
      code: "SOURCE.ORIGIN_BLOCKED",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "SCRAPERAPI.AUTH"],
    [403, "SCRAPERAPI.PROVIDER_FAILURE"],
    [429, "SCRAPERAPI.THROTTLED"],
    [500, "SCRAPERAPI.PROVIDER_FAILURE"],
  ])("status %i is one failed request, %s", async (status, code) => {
    const { client, calls } = provider({ status });
    await expect(client.get(request(), signal())).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
  });

  it.each([404, 410])("keeps status %i as the page's own answer", async (status) => {
    const { client } = provider({ status });
    expect(await client.get(request(), signal())).toMatchObject({ status });
  });

  it("follows a same-site redirect; a redirect to another site is refused and never followed", async () => {
    const slugged = `${ORIGIN}/products/example-slug`;
    const same = provider(
      { status: 301, headers: { location: "/products/example-slug" } },
      { status: 200 },
    );
    expect(await same.client.get(request(), signal())).toMatchObject({ status: 200, url: slugged });
    expect(same.calls.map((call) => call.searchParams.get("url"))).toEqual([target, slugged]);
    const foreign = provider({ status: 302, headers: { location: "https://evil.example/x?y=1" } });
    await expect(foreign.client.get(request(), signal())).rejects.toMatchObject({
      code: "SCRAPERAPI.REDIRECT_UNVERIFIED",
      details: { status: 302, target, location: "https://evil.example/x?y=1" },
    });
    expect(foreign.calls).toHaveLength(1);
  });

  it("never records a redirect to ScraperAPI itself or one carrying the key", async () => {
    const leak = `https://api.scraperapi.com/?api_key=${access.apiKey}`;
    const { client } = provider({ status: 302, headers: { location: leak } });
    const error = await client.get(request(), signal()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "SCRAPERAPI.REDIRECT_UNVERIFIED" });
    expect(JSON.stringify(error)).not.toContain(access.apiKey);
  });

  it("reports a same-site address ScraperAPI finally fetched from; the channel decides if it is the product", async () => {
    // Costco 2026-10-01: .product.<id>.html lands on /p/-/<slug>/<id>?DM_PersistentCookieCreated=true.
    const moved = `${ORIGIN}/products/other`;
    const { client, calls } = provider({ status: 200, headers: { "sa-final-url": moved } });
    await expect(client.get(request(), signal())).resolves.toMatchObject({
      status: 200,
      url: moved,
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses a page ScraperAPI finally fetched from another site", async () => {
    const moved = "https://elsewhere.example/products/other";
    const { client } = provider({ status: 200, headers: { "sa-final-url": moved } });
    await expect(client.get(request(), signal())).rejects.toMatchObject({
      code: "SCRAPERAPI.REDIRECT_UNVERIFIED",
      details: { status: 200, finalUrl: moved },
    });
  });

  it("reports a network failure as unknown, without the provider address or key", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const failure = new Error(`https://api.scraperapi.com/?api_key=${access.apiKey}`);
    agent
      .get("https://api.scraperapi.com")
      .intercept({ path: () => true })
      .replyWithError(failure);
    const client = new ScraperApiClient(access, { dispatcher: agent });
    const error = await client.get(request(), signal()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "SCRAPERAPI.EXECUTION_UNKNOWN" });
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain(access.apiKey);
  });

  it("gives up on a stuck request when cancelled, as unknown", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://api.scraperapi.com")
      .intercept({ path: () => true })
      .reply(200, "late")
      .delay(2_000);
    const client = new ScraperApiClient(access, { dispatcher: agent });
    const controller = new AbortController();
    const pending = client.get(request(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "SCRAPERAPI.EXECUTION_UNKNOWN" });
  });

  it("stops reading a page larger than the caller's limit with the caller's own error", async () => {
    const { client } = provider({ status: 200, body: "x".repeat(2_000) });
    await expect(client.get(request({ maxBytes: 100 }), signal())).rejects.toMatchObject({
      code: "CONFIG.TOO_LARGE",
    });
  });
});
