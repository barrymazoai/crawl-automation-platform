import { isDeepStrictEqual as equal } from 'node:util';
import type pg from 'pg';
import { AmazonProductJobSchema, type AmazonProductJob } from '@crawl-automation/v3-contracts';
import { amazonProductAddress } from '../../../packages/v3-channels/src/amazon-rendered.js';
import type { AmazonHtmlFetchGate } from '../../../packages/v3-channels/src/amazon-html-archive.js';

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
      const recent = (await c.query(`SELECT job,captured_at,
        greatest(requested_at,captured_at)>clock_timestamp()-interval '24 hours' AS active
        FROM amazon_html_fetch WHERE site=$1 AND asin=$2 ORDER BY requested_at DESC LIMIT 1`, [site, asin])).rows[0];
      // The request may be older than 24h while its completed HTML is younger.
      // Resolve a lost DB acknowledgment before admitting another paid request.
      if (recent && !recent.active && !recent.captured_at) {
        const saved = await this.inspectOriginal(AmazonProductJobSchema.parse(recent.job), AbortSignal.any([signal, AbortSignal.timeout(4000)]));
        if (saved) {
          const row = (await c.query(`UPDATE amazon_html_fetch SET captured_at=$2 WHERE operation_id=$1 AND captured_at IS NULL
            RETURNING greatest(requested_at,captured_at)>clock_timestamp()-interval '24 hours' AS active`, [recent.job.operationId, saved.capturedAt])).rows[0];
          if (!row) throw Error('AMAZON.HTML_FETCH_RECEIPT_CONFLICT');
          recent.active = row.active;
        }
      }
      if (!recent?.active) await c.query('INSERT INTO amazon_html_fetch(operation_id,site,asin,job) VALUES($1,$2,$3,$4)', [job.operationId, site, asin, job]);
      signal.throwIfAborted();
      await c.query('COMMIT');
      signal.throwIfAborted();
      return recent?.active ? { kind: 'reuse' as const, job: AmazonProductJobSchema.parse(recent.job) } : { kind: 'download' as const };
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
