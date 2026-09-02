import { describe, expect, it } from "vitest";
import { createScraperApiKeyPool } from "./scraperapi-credits.js";

function accounts(balances: Record<string, number>) {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    calls += 1;
    const key = new URL(String(input)).searchParams.get("api_key")!;
    return new Response(JSON.stringify({ creditsLeft: balances[key] }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("ScraperAPI key 池", () => {
  it("按顺序用第一个余额够的 key，用完自动换下一个", async () => {
    const a = accounts({ k1: 150, k2: 4000 });
    const pool = createScraperApiKeyPool({ keys: ["k1", "k2"], minCredits: 200, fetchImpl: a.fetchImpl });
    expect(await pool.current()).toBe("k2");
    expect(await pool.allow()).toBe(true);
  });

  it("全部耗尽时不放行，并记录一次耗尽事件", async () => {
    const a = accounts({ k1: 50, k2: 0 });
    const events: any[] = [];
    const pool = createScraperApiKeyPool({ keys: ["k1", "k2"], minCredits: 200, fetchImpl: a.fetchImpl, log: (e) => events.push(e) });
    expect(await pool.allow()).toBe(false);
    expect(await pool.allow()).toBe(false);
    expect(events.filter((e) => e.type === "scraperapi_all_keys_exhausted")).toHaveLength(1);
  });

  it("60 秒内同一个 key 只查一次账户接口；invalidate 后重查", async () => {
    const a = accounts({ k1: 4000 });
    const pool = createScraperApiKeyPool({ keys: ["k1"], minCredits: 200, fetchImpl: a.fetchImpl });
    await pool.current(); await pool.current(); await pool.current();
    expect(a.calls()).toBe(1);
    pool.invalidate();
    await pool.current();
    expect(a.calls()).toBe(2);
  });

  it("账户接口打不通时放行，不因守卫本身卡死队列", async () => {
    const pool = createScraperApiKeyPool({ keys: ["k1"], minCredits: 200, fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch });
    expect(await pool.current()).toBe("k1");
  });
});
