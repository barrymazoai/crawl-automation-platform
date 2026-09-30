import { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformErrors } from "../errors/platform-errors.js";
import { ScraperApiClient, type ScraperApiRequest } from "./scraperapi-client.js";

const target = "https://page.test/product";
const access = { apiKey: "test_only_canary_NOT_A_KEY", allowedOrigins: ["https://page.test"] };
const request: ScraperApiRequest = {
  target,
  options: { countryCode: "gb", sessionNumber: 42, render: true, premium: true },
  maxBytes: 1024,
  tooLarge: () => platformErrors.create("CONFIG.TOO_LARGE"),
};
const agents: MockAgent[] = [];

function provider() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  const pool = agent.get("https://api.scraperapi.com");
  const dispatch = vi.spyOn(agent, "dispatch");
  const client = new ScraperApiClient(access, { dispatcher: agent });
  return { pool, dispatch, client };
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  vi.restoreAllMocks();
});

describe("ScraperAPI getOnce", () => {
  it.each([200, 404, 410])(
    "returns status %i and raw bytes from exactly one request",
    async (status) => {
      const { client, pool, dispatch } = provider();
      const bytes = Buffer.from([0xff, 0x00, 0x3c, 0x3e]);
      pool.intercept({ path: () => true, method: "GET" }).reply(status, bytes, {
        headers: {
          "content-type": "text/html",
          "content-encoding": "identity",
          "sa-credit-cost": "5",
        },
      });
      const page = await client.getOnce(request, new AbortController().signal);
      expect(page).toEqual({
        status,
        url: target,
        bytes,
        contentType: "text/html",
        contentEncoding: "identity",
        creditCost: 5,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      const options = dispatch.mock.calls[0]?.[0];
      const url = new URL(String(options?.path), "https://api.scraperapi.com");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        api_key: access.apiKey,
        country_code: "gb",
        follow_redirect: "false",
        session_number: "42",
        render: "true",
        premium: "true",
        url: target,
      });
      expect(JSON.stringify(page)).not.toContain(access.apiKey);
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "refuses redirect %i without paying for the next page",
    async (status) => {
      const { client, pool, dispatch } = provider();
      pool.intercept({ path: () => true }).reply(status, "moved", {
        headers: { location: "/moved" },
      });
      // A retry or redirect follow would succeed, making either regression visible.
      pool.intercept({ path: () => true }).reply(200, "must not be fetched");
      await expect(client.getOnce(request, new AbortController().signal)).rejects.toMatchObject({
        code: "SCRAPERAPI.REDIRECT_UNVERIFIED",
        details: { status, target, location: "https://page.test/moved" },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, "SCRAPERAPI.AUTH"],
    [429, "SCRAPERAPI.THROTTLED"],
    [500, "SCRAPERAPI.PROVIDER_FAILURE"],
  ])("preserves the failure for status %i without retrying", async (status, code) => {
    const { client, pool, dispatch } = provider();
    pool.intercept({ path: () => true }).reply(status, "failed");
    pool.intercept({ path: () => true }).reply(200, "must not be retried");
    await expect(client.getOnce(request, new AbortController().signal)).rejects.toMatchObject({
      code,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("records an unexpected provider-reported final address without refetching it", async () => {
    const { client, pool, dispatch } = provider();
    const finalUrl = "https://page.test/other";
    pool.intercept({ path: () => true }).reply(200, "other page", {
      headers: { "sa-final-url": finalUrl },
    });
    await expect(client.getOnce(request, new AbortController().signal)).rejects.toMatchObject({
      code: "SCRAPERAPI.REDIRECT_UNVERIFIED",
      details: { status: 200, target, finalUrl },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never retries an unknown network outcome or includes the secret in its error", async () => {
    const { client, pool, dispatch } = provider();
    pool.intercept({ path: () => true }).replyWithError(new Error(access.apiKey));
    pool.intercept({ path: () => true }).reply(200, "must not be retried");
    const error = await client
      .getOnce(request, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "SCRAPERAPI.EXECUTION_UNKNOWN" });
    expect(JSON.stringify(error)).not.toContain(access.apiKey);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("stops a cancelled request without starting another", async () => {
    const { client, pool, dispatch } = provider();
    pool
      .intercept({ path: () => true })
      .reply(200, "late")
      .delay(100);
    const controller = new AbortController();
    const pending = client.getOnce(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "SCRAPERAPI.EXECUTION_UNKNOWN" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves the caller's size-limit error without retrying", async () => {
    const { client, pool, dispatch } = provider();
    pool.intercept({ path: () => true }).reply(200, "x".repeat(1025));
    await expect(client.getOnce(request, new AbortController().signal)).rejects.toMatchObject({
      code: "CONFIG.TOO_LARGE",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { change: { target: "https://foreign.test/product" }, code: "SOURCE.ORIGIN_BLOCKED" },
    { change: { options: { countryCode: "invalid" } }, code: "SCRAPERAPI.CONFIG_INVALID" },
  ])("refuses invalid input before submitting: $code", async ({ change, code }) => {
    const { client, dispatch } = provider();
    await expect(
      client.getOnce({ ...request, ...change }, new AbortController().signal),
    ).rejects.toMatchObject({ code });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
