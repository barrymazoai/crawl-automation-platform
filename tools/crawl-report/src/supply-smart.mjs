// crawlReport.submit on Supply Smart's product-database gateway (KAN-229; contract: supply-smart-mono
// docs/packages/database-api/domains/crawl-run-report.md), called with the service key product sync uses
// (SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY in a private env file; the key is never logged).
// A report for the same (source, runId) replaces the stored one, so a timeout or 5xx is sent again.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pRetry, { AbortError } from 'p-retry';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function supplySmartFromEnvFile(file, { log, timeoutMs = 60_000, retries = 3 }) {
  const env = parseEnv(await readFile(file, 'utf8'));
  const root = env.SUPPLY_SMART_DATABASE_RPC_URL?.replace(/\/+$/, '');
  const apiKey = env.SUPPLY_SMART_API_KEY;
  if (!root || !apiKey) throw new Error(`${file} needs SUPPLY_SMART_DATABASE_RPC_URL and SUPPLY_SMART_API_KEY`);
  const call = (path, input) =>
    pRetry(
      async () => {
        const response = await fetch(`${root}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ json: input }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.json !== undefined) return body.json;
        const error = new Error(`${path}: HTTP ${response.status} ${body?.json?.code ?? ''} ${body?.json?.message ?? ''}`.trim());
        throw RETRYABLE.has(response.status) || response.ok ? error : new AbortError(error);
      },
      {
        retries,
        minTimeout: 15_000,
        factor: 2,
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
          log.warn({ path, attemptNumber, retriesLeft, err: error.message }, 'Supply Smart call failed'),
      },
    );
  return {
    host: new URL(root).host,
    submit: (report) => call('crawlReport/submit', report),
  };
}
