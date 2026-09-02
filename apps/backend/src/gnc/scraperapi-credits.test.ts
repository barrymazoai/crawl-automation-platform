import { describe, expect, it } from "vitest";
import { createScraperApiCreditGuard } from "./scraperapi-credits.js";

const account = (creditsLeft: number) => (async () => new Response(JSON.stringify({ creditsLeft }), { status: 200 })) as typeof fetch;

describe("ScraperAPI 余额守卫", () => {
  it("余额低于阈值不领任务，够了才领", async () => {
    expect(await createScraperApiCreditGuard({ apiKey: "k", minCredits: 200, fetchImpl: account(150) }).allow()).toBe(false);
    expect(await createScraperApiCreditGuard({ apiKey: "k", minCredits: 200, fetchImpl: account(5000) }).allow()).toBe(true);
  });

  it("60 秒内只查一次账户接口", async () => {
    let calls = 0;
    const guard = createScraperApiCreditGuard({ apiKey: "k", minCredits: 200, fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify({ creditsLeft: 5000 })); }) as typeof fetch });
    await guard.allow(); await guard.allow(); await guard.allow();
    expect(calls).toBe(1);
  });

  it("账户接口打不通时放行，不因守卫本身卡死队列", async () => {
    const guard = createScraperApiCreditGuard({ apiKey: "k", minCredits: 200, fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch });
    expect(await guard.allow()).toBe(true);
  });
});
