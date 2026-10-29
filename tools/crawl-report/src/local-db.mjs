// Local test only (KAN-229, before the endpoint is deployed): writes the reports straight into a local Supply
// Smart product database's crawl_report table (migrations 0086, 0087), with no API key. Supply Smart's own counts
// (new records, brands, companies) are left empty: only crawlReport.submit computes them. The connection comes
// from Supply Smart's packages/product-db/.env (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) and must be
// localhost; the password is never logged.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

export async function localDbFromEnvFile(file) {
  const env = parseEnv(await readFile(file, 'utf8'));
  if (!LOCAL.has(env.DB_HOST)) throw new Error(`${file}: DB_HOST must be localhost for a direct write`);
  const client = new pg.Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  });
  await client.connect();
  return {
    target: `${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
    async submit(r) {
      const { rows } = await client.query(
        `INSERT INTO crawl_report (source, run_key, ingest_run_keys, server, crawler, started_at, finished_at, status,
           scope, schedule_every_days, targets, fetched, failed, pushed, breakdown, error_code, error_message,
           ingest_from, ingest_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (source, run_key) DO UPDATE SET ingest_run_keys = EXCLUDED.ingest_run_keys,
           ingest_from = EXCLUDED.ingest_from, ingest_to = EXCLUDED.ingest_to,
           server = EXCLUDED.server, crawler = EXCLUDED.crawler, started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at, status = EXCLUDED.status, scope = EXCLUDED.scope,
           schedule_every_days = EXCLUDED.schedule_every_days, targets = EXCLUDED.targets,
           fetched = EXCLUDED.fetched, failed = EXCLUDED.failed, pushed = EXCLUDED.pushed,
           breakdown = EXCLUDED.breakdown, error_code = EXCLUDED.error_code,
           error_message = EXCLUDED.error_message, updated_at = now()
         RETURNING id, (xmax <> 0) AS duplicate`,
        [
          r.source,
          r.runId,
          r.ingestRunIds ?? (r.ingestWindow ? [] : [r.runId]),
          r.server,
          r.crawler ?? null,
          r.startedAt,
          r.finishedAt,
          r.status,
          r.scope,
          r.schedule?.everyDays ?? null,
          r.counts.targets,
          r.counts.fetched,
          r.counts.failed,
          r.counts.pushed,
          r.breakdown ?? null,
          r.error?.code ?? null,
          r.error?.message ?? null,
          r.ingestWindow?.from ?? null,
          r.ingestWindow?.to ?? null,
        ],
      );
      return { reportId: rows[0].id, duplicate: rows[0].duplicate, counted: null, warnings: [] };
    },
    close: () => client.end(),
  };
}
