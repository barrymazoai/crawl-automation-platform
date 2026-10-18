// Throttled, retried GET with a raw-response cache. One request per host per
// interval; 403/401/451 are "blocked" and never retried; a host that blocks
// several requests in a row stops its source (the run reports it, it does not
// switch to another route).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import pRetry, { AbortError } from 'p-retry';
import pThrottle from 'p-throttle';

const BLOCKED_STATUS = new Set([401, 403, 451]);

export class BlockedError extends Error {
  constructor(url, status) {
    super(`blocked: HTTP ${status} ${url}`);
    this.url = url;
    this.status = status;
  }
}

export class HostBlockedError extends Error {
  constructor(host, count) {
    super(`host ${host} blocked ${count} requests in a row; source stopped`);
    this.host = host;
  }
}

export function createHttp({ cacheDir, log, userAgent, intervalMs, retries, timeoutMs, maxConsecutiveBlocks, offline }) {
  const throttles = new Map();
  const blockedInRow = new Map();

  function throttleFor(host) {
    if (!throttles.has(host)) throttles.set(host, pThrottle({ limit: 1, interval: intervalMs })((fn) => fn()));
    return throttles.get(host);
  }

  function cachePaths(url) {
    const key = createHash('sha256').update(url).digest('hex');
    const dir = join(cacheDir, new URL(url).host, key.slice(0, 2));
    return { dir, body: join(dir, `${key}.gz`), meta: join(dir, `${key}.json`) };
  }

  async function readCache(url) {
    const p = cachePaths(url);
    try {
      const meta = JSON.parse(await readFile(p.meta, 'utf8'));
      return { ...meta, body: gunzipSync(await readFile(p.body)), fromCache: true };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeCache(url, response) {
    const p = cachePaths(url);
    await mkdir(p.dir, { recursive: true });
    const { body, ...meta } = response;
    await writeFile(`${p.body}.tmp`, gzipSync(body));
    await rename(`${p.body}.tmp`, p.body);
    await writeFile(`${p.meta}.tmp`, JSON.stringify(meta));
    await rename(`${p.meta}.tmp`, p.meta);
  }

  async function fetchOnce(url, headers) {
    const res = await throttleFor(new URL(url).host)(() =>
      fetch(url, {
        headers: { 'user-agent': userAgent, ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (BLOCKED_STATUS.has(res.status)) throw new AbortError(new BlockedError(url, res.status));
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${url}`);
    if (!res.ok) throw new AbortError(new Error(`HTTP ${res.status} ${url}`));
    return {
      url,
      finalUrl: res.url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      fetchedAt: new Date().toISOString(),
      body: Buffer.from(await res.arrayBuffer()),
    };
  }

  // cache: 'fresh' always requests; 'prefer' uses a cached copy when present.
  // Offline runs never request.
  async function get(requests, url, { cache = 'fresh', headers = {} } = {}) {
    if (offline || cache === 'prefer') {
      const cached = await readCache(url);
      if (cached) return cached;
      if (offline) throw new Error(`offline: no cached copy of ${url}`);
    }
    const host = new URL(url).host;
    const entry = { url, startedAt: new Date().toISOString(), attempts: 0 };
    requests.push(entry);
    try {
      const response = await pRetry(
        () => {
          entry.attempts += 1;
          return fetchOnce(url, headers);
        },
        {
          retries,
          minTimeout: 2000,
          factor: 2,
          onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
            log.warn({ url, attemptNumber, retriesLeft, err: error.message }, 'request failed'),
        },
      );
      entry.status = response.status;
      entry.outcome = 'ok';
      blockedInRow.set(host, 0);
      await writeCache(url, response);
      return response;
    } catch (error) {
      entry.error = error.message;
      if (error instanceof BlockedError) {
        entry.status = error.status;
        entry.outcome = 'blocked';
        const count = (blockedInRow.get(host) ?? 0) + 1;
        blockedInRow.set(host, count);
        log.error({ url, status: error.status, blockedInRow: count }, 'request blocked');
        if (count >= maxConsecutiveBlocks) throw new HostBlockedError(host, count);
      } else {
        entry.outcome = 'failed';
        log.error({ url, err: error.message }, 'request failed after retries');
      }
      throw error;
    }
  }

  // Each source gets its own request log; throttles and block counts are per host.
  return {
    forSource() {
      const requests = [];
      return {
        get: (url, options) => get(requests, url, options),
        text: async (url, options) => (await get(requests, url, options)).body.toString('utf8'),
        requests,
      };
    },
  };
}
