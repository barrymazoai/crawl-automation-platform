// Supply Smart's regulatory procedures on its product-database gateway, called
// with the service key product sync uses (contract: supply-smart-mono
// docs/packages/database-api/domains/regulatory-ingest.md). oRPC wraps the body
// and the answer in {"json": ...}.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pRetry, { AbortError } from 'p-retry';

// A call that failed before or inside Supply Smart's transaction left nothing
// behind, so the same batch may be sent again; anything else needs a person.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class SupplySmartError extends Error {
  constructor(path, status, body) {
    super(`${path}: HTTP ${status} ${body?.json?.code ?? ''} ${body?.json?.message ?? ''}`.trim());
    this.name = 'SupplySmartError';
    this.status = status;
    this.code = body?.json?.code ?? null;
    this.data = body?.json?.data ?? null;
  }
}

/** Reads SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY from a private env file; the key is never logged. */
export async function supplySmartFromEnvFile(file, { log, timeoutMs = 180_000, retries = 4 }) {
  const env = parseEnv(await readFile(file, 'utf8'));
  const root = env.SUPPLY_SMART_DATABASE_RPC_URL?.replace(/\/+$/, '');
  const key = env.SUPPLY_SMART_API_KEY;
  if (!root || !key) throw new Error(`${file} needs SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY`);

  async function call(path, input) {
    return pRetry(
      async () => {
        let response;
        try {
          response = await fetch(`${root}/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key },
            body: JSON.stringify({ json: input }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          // Network error or timeout: unknown whether it committed; a re-send is safe.
          throw new Error(`${path}: ${error.name} ${error.message}`);
        }
        const body = await response.json().catch(() => null);
        if (response.ok) return body?.json;
        const error = new SupplySmartError(path, response.status, body);
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
  }

  return {
    endpoint: root,
    ingest: (input) => call('regulatory/ingest', input),
    overview: (input) => call('regulatory/overview', input),
  };
}
