import { isDeepStrictEqual as equal } from 'node:util';
import type pg from 'pg';
import { AmazonProductJobSchema, type AmazonProductJob } from '@crawl-automation/v3-contracts';
import { amazonProductAddress } from '../../../packages/v3-channels/src/amazon-rendered.js';
import type { AmazonHtmlFetchGate } from '../../../packages/v3-channels/src/amazon-html-archive.js';

/** Longest a provider download can still be running (75s request timeout plus archive publication). */
const DOWNLOAD_IN_FLIGHT = '10 minutes';

/** A short transaction serializes admission across every Worker/campaign. The lock
 * ends before network I/O. The durable attempt remains even if the process dies. */
export class PostgresAmazonHtmlFetchGate implements AmazonHtmlFetchGate {
  constructor(private readonly db: pg.Pool,
    private readonly inspectOriginal: (job: AmazonProductJob, signal: AbortSignal) => Promise<{ capturedAt: string } | null>) {}
  async acquire(raw: AmazonProductJob, signal: AbortSignal) {
    const job = AmazonProductJobSchema.parse(raw), address = amazonProductAddress(job.discovery.entry.url);
    const site = new URL(address.url).origin, asin = address.asin;
    if (asin !== job.discovery.entry.listingId) throw Error('AMAZON.HTML_ARCHIVE_IDENTITY');
    signal.throwIfAborted();
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'");
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73110324))', [JSON.stringify([site, asin])]);
      signal.throwIfAborted();
      // An expired attempt never authorizes the same operation to try again.
      if ((await c.query('SELECT 1 FROM amazon_html_fetch WHERE operation_id=$1', [job.operationId])).rowCount)
        throw Error('AMAZON.HTML_DOWNLOAD_UNRESOLVED');
      // The window belongs to the HTML, not to the provider request: only a verified original
      // captured in the last 24h is reused. An attempt that ended without HTML leaves nothing to
      // reuse, so once it can no longer be running it does not hold back a new download.
      const rows = (await c.query(`SELECT job,captured_at,
        captured_at>clock_timestamp()-interval '24 hours' AS fresh,
        requested_at>clock_timestamp()-interval '${DOWNLOAD_IN_FLIGHT}' AS in_flight
        FROM amazon_html_fetch WHERE site=$1 AND asin=$2 AND (captured_at>clock_timestamp()-interval '24 hours'
          OR (captured_at IS NULL AND requested_at>clock_timestamp()-interval '24 hours ${DOWNLOAD_IN_FLIGHT}'))
        ORDER BY coalesce(captured_at,requested_at) DESC LIMIT 3`, [site, asin])).rows;
      let reuse = rows.find(r => r.fresh)?.job;
      for (const r of reuse ? [] : rows) {
        // A download that may still be running is never doubled by a second paid request.
        if (r.in_flight) { reuse = r.job; break; }
        // Resolve a lost DB acknowledgment before admitting another paid request.
        const saved = await this.inspectOriginal(AmazonProductJobSchema.parse(r.job), AbortSignal.any([signal, AbortSignal.timeout(4000)]));
        if (!saved) continue;
        const row = (await c.query(`UPDATE amazon_html_fetch SET captured_at=$2 WHERE operation_id=$1 AND captured_at IS NULL
          RETURNING captured_at>clock_timestamp()-interval '24 hours' AS fresh`, [r.job.operationId, saved.capturedAt])).rows[0];
        if (!row) throw Error('AMAZON.HTML_FETCH_RECEIPT_CONFLICT');
        if (row.fresh) { reuse = r.job; break; }
      }
      if (!reuse) await c.query('INSERT INTO amazon_html_fetch(operation_id,site,asin,job) VALUES($1,$2,$3,$4)', [job.operationId, site, asin, job]);
      signal.throwIfAborted();
      await c.query('COMMIT');
      signal.throwIfAborted();
      return reuse ? { kind: 'reuse' as const, job: AmazonProductJobSchema.parse(reuse) } : { kind: 'download' as const };
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async complete(raw: AmazonProductJob, capturedAt: string, signal: AbortSignal) {
    const job = AmazonProductJobSchema.parse(raw);
    signal.throwIfAborted();
    await this.db.query('UPDATE amazon_html_fetch SET captured_at=$2 WHERE operation_id=$1 AND captured_at IS NULL AND job=$3', [job.operationId, capturedAt, job]);
    const row = (await this.db.query('SELECT job,captured_at FROM amazon_html_fetch WHERE operation_id=$1', [job.operationId])).rows[0];
    if (!row || !equal(row.job, job) || row.captured_at?.toISOString() !== capturedAt)
      throw Error('AMAZON.HTML_FETCH_RECEIPT_CONFLICT');
    signal.throwIfAborted();
  }
}
