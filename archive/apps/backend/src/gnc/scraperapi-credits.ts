/**
 * ScraperAPI key 池 + 余额守卫。
 *
 * 免费账号每个 5000 credits（GNC 域名 10 credits/次），用完就换下一个 key；
 * 全部用完时 allow() 返回 false，worker 不再领任务、原地等待，队列不丢——
 * 追加新 key 到 SCRAPERAPI_KEYS 后重启 worker 即可续跑。
 * 每个 key 的余额缓存 60 秒，避免每次 claim 轮询都打账户接口。
 */
export interface ScraperApiKeyPoolOptions {
  keys: string[];
  minCredits: number;
  log?: (event: object) => void;
  fetchImpl?: typeof fetch;
  cacheMs?: number;
}

export function maskKey(key: string) {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function createScraperApiKeyPool(options: ScraperApiKeyPoolOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheMs = options.cacheMs ?? 60_000;
  const cache = new Map<string, { at: number; creditsLeft: number | null }>();
  let activeKey: string | null = null;
  let exhaustedWarned = false;

  async function creditsLeft(key: string): Promise<number | null> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.creditsLeft;
    let value: number | null = null;
    try {
      const response = await fetchImpl(`https://api.scraperapi.com/account?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as { creditsLeft?: number };
      value = typeof body.creditsLeft === "number" ? body.creditsLeft : null;
    } catch (error) {
      options.log?.({ type: "scraperapi_account_probe_failed", key: maskKey(key), message: error instanceof Error ? error.message : String(error) });
    }
    cache.set(key, { at: Date.now(), creditsLeft: value });
    return value;
  }

  /** 让下一次 current() 重新查余额（一个 job 跑完后调用，别拿 60 秒前的数）。 */
  function invalidate() { cache.clear(); }

  /**
   * 当前可用的 key：按顺序找第一个余额 ≥ minCredits 的；余额未知（接口失败）的 key 也算可用，
   * 交给请求本身去失败进复核。全部耗尽返回 null。
   */
  async function current(): Promise<string | null> {
    for (const key of options.keys) {
      const left = await creditsLeft(key);
      if (left == null || left >= options.minCredits) {
        if (key !== activeKey) {
          options.log?.({ type: "scraperapi_key_selected", key: maskKey(key), creditsLeft: left, index: options.keys.indexOf(key), total: options.keys.length });
          activeKey = key;
        }
        exhaustedWarned = false;
        return key;
      }
    }
    if (!exhaustedWarned) {
      const balances = await Promise.all(options.keys.map(async (key) => ({ key: maskKey(key), creditsLeft: await creditsLeft(key) })));
      options.log?.({ type: "scraperapi_all_keys_exhausted", minCredits: options.minCredits, balances, hint: "追加新 key 到 SCRAPERAPI_KEYS 后 ./deploy.sh --only capture-gnc-scraperapi" });
      exhaustedWarned = true;
    }
    activeKey = null;
    return null;
  }

  /** 适配器收到 403 时调用：把这把 key 记为耗尽（不再查它），返回下一把可用 key。 */
  async function exhausted(key: string): Promise<string | null> {
    cache.set(key, { at: Date.now(), creditsLeft: 0 });
    options.log?.({ type: "scraperapi_key_exhausted_midjob", key: maskKey(key) });
    return current();
  }

  return {
    current,
    exhausted,
    invalidate,
    creditsLeft,
    async allow(): Promise<boolean> { return (await current()) != null; },
    async balances() { return Promise.all(options.keys.map(async (key) => ({ key: maskKey(key), creditsLeft: await creditsLeft(key) }))); },
  };
}
