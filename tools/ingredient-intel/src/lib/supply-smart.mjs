// Supply Smart's product-database gateway, read with the service key product sync uses
// (SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY in a private env file; the key is never logged).
// Read-only procedures that exist today; writing waits for the ingest procedure (P4).
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
        if (response.ok) return body?.json;
        const error = new Error(`${path}: HTTP ${response.status} ${body?.json?.code ?? ''} ${body?.json?.message ?? ''}`.trim());
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
