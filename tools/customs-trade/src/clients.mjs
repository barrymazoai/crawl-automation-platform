// HTTP clients: the Census International Trade API (read) and Supply Smart's customsTrade.ingest (write).
// Keys come from a private env file and are never logged; errors name the path, never the URL with the key.
import { setTimeout as sleep } from 'node:timers/promises';
import { FIELDS, tableToObjects } from './slices.mjs';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Retries network errors and RETRYABLE statuses with backoff; other failures are thrown at once */
async function withRetry(what, fn, { retries, minDelayMs, log }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err.retryable ?? !err.status;
      if (!retryable || attempt > retries) throw err;
      const delay = minDelayMs * 2 ** (attempt - 1);
      log.warn?.({ what, attempt, delayMs: delay, err: err.message }, 'retrying');
      await sleep(delay);
    }
  }
}

function httpError(what, status, detail) {
  const err = new Error(`${what}: HTTP ${status}${detail ? ` ${detail}` : ''}`);
  err.status = status;
  err.retryable = RETRYABLE.has(status);
  return err;
}

export function createCensus({ apiKey, log, intervalMs = 400, retries = 4, minDelayMs = 5_000, timeoutMs = 120_000 }) {
  if (!apiKey) throw new Error('CENSUS_API_KEY is required');
  let last = 0;
  const pace = async () => {
    const wait = last + intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };

  /** Raw rows of one direction × code for [from, to]; [] when Census has no data (204) */
  async function rows(direction, code, from, to) {
    const params = new URLSearchParams({
      get: FIELDS[direction].join(','),
      [direction === 'import' ? 'I_COMMODITY' : 'E_COMMODITY']: code,
      time: `from ${from} to ${to}`,
    });
    if (direction === 'export') params.set('DF', '1'); // domestic exports, as DataWeb "Exports: Domestic"
    const what = `census ${direction}/hs ${code} ${from}..${to}`;
    params.set('key', apiKey);
    const url = `https://api.census.gov/data/timeseries/intltrade/${direction}s/hs?${params}`;
    return withRetry(
      what,
      async () => {
        await pace();
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 204) return [];
        if (res.status === 301 || res.status === 302) {
          const where = res.headers.get('location') ?? '';
          const err = new Error(`${what}: Census refused the key (${where.includes('invalid_key') ? 'invalid' : 'missing'} key)`);
          err.status = res.status;
          err.retryable = false;
          throw err;
        }
        if (!res.ok) throw httpError(what, res.status);
        return tableToObjects(await res.json());
      },
      { retries, minDelayMs, log },
    );
  }

  /**
   * The latest month Census has published, probed with one code that trades every month
   * (an unpublished month answers 204).
   */
  async function latestMonth({ probeCode, now = new Date(), lookBack = 6 }) {
    for (let i = 1; i <= lookBack; i += 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      if ((await rows('import', probeCode, m, m)).length) return m;
    }
    throw new Error(`no published month in the last ${lookBack} for probe code ${probeCode}`);
  }

  return { rows, latestMonth };
}

export function createSupplySmart({ databaseRpcUrl, apiKey, log, retries = 4, minDelayMs = 30_000, timeoutMs = 180_000 }) {
  const root = databaseRpcUrl?.replace(/\/+$/, '');
  if (!root || !apiKey) throw new Error('SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY are required');

  // oRPC wraps the body and the answer in {"json": ...}. A re-sent batch is counted once on the
  // Supply Smart side, so a timeout or 5xx is retried with the same batch.
  const call = (path, input) =>
    withRetry(
      path,
      async () => {
        const res = await fetch(`${root}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ json: input }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.json === undefined) throw Object.assign(new Error(`${path}: HTTP 200 without a readable answer`), { retryable: true });
        if (res.ok) return body.json;
        const err = httpError(path, res.status, [body?.json?.code, body?.json?.message].filter(Boolean).join(' '));
        err.data = body?.json?.data;
        throw err;
      },
      { retries, minDelayMs, log },
    );

  return {
    host: new URL(root).host,
    /** customsTrade.ingest: { run: { runId, fetchedAt }, batchId, dryRun, slices } */
    ingest: (body) => call('customsTrade/ingest', body),
  };
}
