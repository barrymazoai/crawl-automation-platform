// Supply Smart's product-database gateway, read with the service key product sync uses
// (SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY in a private env file; the key is never logged).
// The writes are the ingest procedures for the crawler (SUPPLYSMAR-463: service key only; a re-sent batch is
// counted once, so a timeout or 5xx is retried with the same batch).
// oRPC wraps the body and the answer in {"json": ...}.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pRetry, { AbortError } from 'p-retry';
import pThrottle from 'p-throttle';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const PAGE = 100;

export async function supplySmartFromEnvFile(file, { log, requestsPerMinute = 120, timeoutMs = 180_000, retries = 4 }) {
  const env = parseEnv(await readFile(file, 'utf8'));
  const root = env.SUPPLY_SMART_DATABASE_RPC_URL?.replace(/\/+$/, '');
  const apiKey = env.SUPPLY_SMART_API_KEY;
  if (!root || !apiKey) throw new Error(`${file} needs SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY`);
  const paced = pThrottle({ limit: 1, interval: Math.ceil(60_000 / requestsPerMinute) })((run) => run());

  const call = (path, input) =>
    pRetry(
      async () => {
        const response = await paced(() =>
          fetch(`${root}/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
            body: JSON.stringify({ json: input }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        );
        const body = await response.json().catch(() => null);
        // A 200 whose body does not parse (cut off on the way) is retried like a server error.
        if (response.ok && body?.json === undefined) throw new Error(`${path}: HTTP 200 without a readable answer`);
        if (response.ok) return body.json;
        const error = new Error(`${path}: HTTP ${response.status} ${body?.json?.code ?? ''} ${body?.json?.message ?? ''}`.trim());
        Object.assign(error, { status: response.status, data: body?.json?.data });
        throw RETRYABLE.has(response.status) ? error : new AbortError(error);
      },
      {
        retries,
        minTimeout: 30_000,
        factor: 2,
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
          log.warn({ path, attemptNumber, retriesLeft, err: error.message }, 'Supply Smart call failed'),
      },
    );

  return {
    host: new URL(root).host,
    /** [{ id, externalKey, name }] — the branded ingredients Supply Smart holds */
    async brandedIngredients() {
      return (await call('brandedIngredient/list')).data;
    },
    /** Every ingredient name: [{ id, name, createdAt }] (≈212k rows, ≈56 MB, one call) */
    async ingredientNames() {
      return (await call('ingredient/listAll')).data;
    },
    /** Every branded ingredient with its links not removed: { items, totals, asOf } (all pages) */
    async syncState() {
      const items = [];
      let cursor = null;
      let page;
      do {
        page = await call('brandedIngredient/syncState', { cursor, limit: 500 });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return { items, totals: page.totals, asOf: page.asOf };
    },
    /** brandedIngredient.ingest: { run: { runId }, batchId, dryRun, records } */
    ingestLinks: (body) => call('brandedIngredient/ingest', body),
    /** clinicalTrial.ingest: { run: { runId, fetchedAt, sourceDb }, batchId, dryRun, trials, companyLinks, productLinks, ingredientLinks } */
    ingestTrials: (body) => call('clinicalTrial/ingest', body),
    /** Map ingredient id → { mainProducts, labelProducts } (product_ingredient / the current label formula) */
    async productCounts(ingredientIds) {
      const out = new Map();
      for (let i = 0; i < ingredientIds.length; i += 500)
        for (const c of (await call('ingredient/productCounts', { ingredientIds: ingredientIds.slice(i, i + 500) })).data) out.set(c.ingredientId, c);
      return out;
    },
    /** Products whose ingredient list holds any of the ids: [{ id, name, company, ingredientIds }] */
    async productsUsing(ingredientIds) {
      const out = [];
      for (let i = 0; i < ingredientIds.length; i += 50) {
        const ids = ingredientIds.slice(i, i + 50);
        const filters = { root: { id: 'root', type: 'group', logic: 'and', filters: [{ id: 'ing', column: 'ingredients', operator: 'includes', value: ids, logic: 'and' }] } };
        for (let page = 1; ; page += 1) {
          const answer = await call('product/listAdvanced', { page, pageSize: PAGE, viewMode: 'skus', queryParams: { filters, sorts: [] } });
          for (const p of answer.products)
            out.push({
              id: p.id,
              name: p.name,
              company: (typeof p.company === 'string' ? p.company : p.company?.name) ?? null,
              ingredientIds: (p.ingredients ?? []).map((x) => x.id),
            });
          if (page * PAGE >= answer.total || answer.products.length === 0) break;
        }
      }
      return out;
    },
  };
}
