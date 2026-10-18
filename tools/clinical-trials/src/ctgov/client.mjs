// ClinicalTrials.gov API v2 (https://clinicaltrials.gov/data-api/api): public, no key.
// One request per interval, retries only network errors, 429 and 5xx; 4xx answers are final.
// Every page is archived gzip-compressed with its sha256 before anything parses it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import pRetry, { AbortError } from 'p-retry';
import pThrottle from 'p-throttle';

export const API = 'https://clinicaltrials.gov/api/v2';
/** protocolSection is everything the import contract reads; resultsSection/derivedSection would triple the size */
export const STUDY_FIELDS = 'protocolSection,hasResults';
export const PAGE_SIZE = 1000;

export function createCtgovClient({ log, intervalMs, retries, timeoutMs, userAgent }) {
  const throttled = pThrottle({ limit: 1, interval: intervalMs })((fn) => fn());
  const requests = [];

  async function getJson(url) {
    const entry = { url, startedAt: new Date().toISOString(), attempts: 0 };
    requests.push(entry);
    const response = await pRetry(
      async () => {
        entry.attempts += 1;
        const res = await throttled(() =>
          fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }),
        );
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${url}`);
        if (!res.ok) throw new AbortError(new Error(`HTTP ${res.status} ${url}: ${(await res.text()).slice(0, 300)}`));
        return { status: res.status, fetchedAt: new Date().toISOString(), body: Buffer.from(await res.arrayBuffer()) };
      },
      {
        retries,
        minTimeout: 5000,
        factor: 2,
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
          log.warn({ url, attemptNumber, retriesLeft, err: error.message }, 'request failed'),
      },
    ).catch((error) => {
      entry.outcome = 'failed';
      entry.error = error.message;
      throw error;
    });
    entry.outcome = 'ok';
    entry.status = response.status;
    entry.bytes = response.body.length;
    return response;
  }

  /** API version and the registry's data timestamp (refreshed once a day, Monday to Friday). */
  async function version() {
    return JSON.parse((await getJson(`${API}/version`)).body.toString('utf8'));
  }

  /**
   * Every page of one /studies query. `params` are API query parameters (query.*, filter.*).
   * Pages are written to `archiveDir/<label>/<n>.json.gz`; yields { studies, page, totalCount, archive, last }.
   */
  async function* studies({ params, label, archiveDir, maxPages = Infinity }) {
    let pageToken;
    let totalCount;
    for (let page = 1; page <= maxPages; page += 1) {
      const search = new URLSearchParams({ ...params, fields: STUDY_FIELDS, pageSize: String(PAGE_SIZE), format: 'json' });
      if (page === 1) search.set('countTotal', 'true');
      if (pageToken) search.set('pageToken', pageToken);
      const url = `${API}/studies?${search}`;
      const response = await getJson(url);
      const archive = await archivePage(archiveDir, label, page, url, response);
      const body = JSON.parse(response.body.toString('utf8'));
      if (page === 1) totalCount = body.totalCount;
      pageToken = body.nextPageToken;
      yield { studies: body.studies ?? [], page, totalCount, archive, last: !pageToken };
      if (!pageToken) return;
    }
    log.warn({ label, maxPages }, 'stopped at --max-pages before the last page');
  }

  return { version, studies, requests };
}

async function archivePage(archiveDir, label, page, url, response) {
  const dir = join(archiveDir, label);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${String(page).padStart(4, '0')}.json.gz`);
  await writeFile(`${file}.tmp`, gzipSync(response.body));
  await rename(`${file}.tmp`, file);
  const sha256 = createHash('sha256').update(response.body).digest('hex');
  // Read the archived copy back before the page is used.
  const stored = createHash('sha256').update(gunzipSync(await readFile(file))).digest('hex');
  if (stored !== sha256) throw new Error(`archive read-back mismatch for ${file}`);
  return { file, url, fetched_at: response.fetchedAt, bytes: response.body.length, sha256 };
}
