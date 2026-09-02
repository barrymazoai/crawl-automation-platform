/**
 * ScraperAPI 余额守卫：领任务前查一次账户余额，低于阈值就不领，队列原地等。
 * 余额耗尽时 ScraperAPI 返回 403，一个品牌会抓到一半失败进复核；守卫让它根本不开始。
 * 结果缓存 60 秒，避免每次 claim 轮询都打账户接口。
 */
export function createScraperApiCreditGuard(options: { apiKey: string; minCredits: number; log?: (event: object) => void; fetchImpl?: typeof fetch; cacheMs?: number }) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheMs = options.cacheMs ?? 60_000;
  let cached: { at: number; creditsLeft: number | null } | null = null;
  let warned = false;

  async function creditsLeft(): Promise<number | null> {
    if (cached && Date.now() - cached.at < cacheMs) return cached.creditsLeft;
    let value: number | null = null;
    try {
      const response = await fetchImpl(`https://api.scraperapi.com/account?api_key=${encodeURIComponent(options.apiKey)}`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as { creditsLeft?: number };
      value = typeof body.creditsLeft === "number" ? body.creditsLeft : null;
    } catch (error) {
      options.log?.({ type: "scraperapi_account_probe_failed", message: error instanceof Error ? error.message : String(error) });
    }
    cached = { at: Date.now(), creditsLeft: value };
    return value;
  }

  return {
    creditsLeft,
    /** 余额未知（接口失败）时放行，交给请求本身去失败进复核；余额已知且不足则拦住。 */
    async allow(): Promise<boolean> {
      const left = await creditsLeft();
      const ok = left == null || left >= options.minCredits;
      if (!ok && !warned) { options.log?.({ type: "scraperapi_credits_low", creditsLeft: left, minCredits: options.minCredits }); warned = true; }
      if (ok) warned = false;
      return ok;
    },
  };
}
