import { MockAgent } from "undici";
import { expect, it } from "vitest";
import { platformErrors } from "../errors/platform-errors.js";
import { ScraperApiClient } from "./scraperapi-client.js";
import { ScraperApiOptionChoicesSchema, ScraperApiOptionsSchema } from "./scraperapi-settings.js";

const origin = "https://www.wholefoodsmarket.com";
const cookie = "wfm_store_d8=10259";
const signal = () => AbortSignal.timeout(5_000);
const tooLarge = () => platformErrors.create("CONFIG.TOO_LARGE");

function setup(replies: Array<{ status: number; headers?: Record<string, string> }>) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const calls: Array<{ path: string; headers: string }> = [];
  for (const reply of replies) {
    agent
      .get("https://api.scraperapi.com")
      .intercept({ path: () => true })
      .reply((request) => {
        calls.push({ path: request.path, headers: JSON.stringify(request.headers) });
        return {
          statusCode: reply.status,
          data: "<main>hand-written test</main>",
          responseOptions: { headers: reply.headers ?? {} },
        };
      });
  }
  const client = new ScraperApiClient(
    {
      apiKey: "test_only_canary",
      allowedOrigins: [
        origin,
        "https://www.swansonvitamins.com",
        "https://www.gnc.com",
        "https://www.amazon.com",
      ],
    },
    { dispatcher: agent },
  );
  return { calls, client };
}

it("sends configured headers with keep_headers on the initial request only", async () => {
  const { client, calls } = setup([
    { status: 302, headers: { location: "/next", "set-cookie": "injected=true" } },
    { status: 200 },
    { status: 200 },
  ]);
  const choices = ScraperApiOptionChoicesSchema.parse({ headers: { Cookie: cookie } });
  const options = ScraperApiOptionsSchema.parse(choices);
  const request = { target: `${origin}/product`, options, maxBytes: 1024, tooLarge };
  await client.get(request, signal());
  await client.get(
    { ...request, target: "https://www.amazon.com/dp/B000000001", options: {} },
    signal(),
  );
  expect(calls[0]?.path).toContain("&keep_headers=true&url=");
  expect(calls[0]?.headers).toContain(cookie);
  for (const call of calls.slice(1)) {
    expect(call.path).not.toContain("keep_headers");
    expect(call.headers).not.toContain(cookie);
    expect(call.headers).not.toContain("injected");
  }
});

it.each([
  ["https://www.swansonvitamins.com/p/test", {}, ""],
  ["https://www.gnc.com/test.html", { premium: true }, "&premium=true"],
  [
    "https://www.amazon.com/dp/B000000001",
    { render: true, sessionNumber: 42 },
    "&session_number=42&render=true",
  ],
])("preserves the exact provider URL for %s", async (target, options, suffix) => {
  const { client, calls } = setup([{ status: 200 }]);
  await client.get({ target, options, maxBytes: 1024, tooLarge }, signal());
  expect(calls[0]?.path).toBe(
    "/?api_key=test_only_canary&country_code=us&follow_redirect=false" +
      suffix +
      "&url=" +
      encodeURIComponent(target),
  );
  expect(calls[0]?.headers).not.toContain("cookie");
});

it.each([
  { Cookie: "private\r\nInjected: yes" },
  { Host: "private" },
  { "x-scraperapi-api-key": "private" },
  { Cookie: "private", cookie: "duplicate" },
])("refuses invalid header configuration without echoing its values", async (headers) => {
  const { client, calls } = setup([]);
  const error = await client
    .get(
      {
        target: `${origin}/product`,
        options: { headers },
        maxBytes: 1024,
        tooLarge,
      },
      signal(),
    )
    .catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "SCRAPERAPI.CONFIG_INVALID" });
  expect(JSON.stringify(error)).not.toContain("private");
  expect(calls).toHaveLength(0);
});

it("does not echo headers reflected in a refused redirect", async () => {
  const { client } = setup([
    {
      status: 302,
      headers: {
        location: `https://evil.example/?secret=${cookie}`,
      },
    },
  ]);
  const error = await client
    .get(
      {
        target: `${origin}/product`,
        options: { headers: { Cookie: cookie } },
        maxBytes: 1024,
        tooLarge,
      },
      signal(),
    )
    .catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "SCRAPERAPI.REDIRECT_UNVERIFIED" });
  expect(JSON.stringify(error)).not.toContain(cookie);
});
