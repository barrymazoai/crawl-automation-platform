// Crawler V3 rounds (Amazon, Costco, GNC, Swanson, Whole Foods, DTC) from the crawler API's read-only
// rounds.list, mapped to crawlReport.submit. The crawler records no "round"; the API groups product lists
// into rounds (apps/api rounds.list, packages/app/src/round-report). Supply Smart counts what was new.
import { readFile } from 'node:fs/promises';

// DTC pages are captured by Server 二's browsers; the other channels' pipeline runs from Server 一.
const SERVER = { dtc: 'server-2' };

export async function crawlerRounds({ api, roundsFile, since, log }) {
  if (roundsFile) return JSON.parse(await readFile(roundsFile, 'utf8'));
  const input = encodeURIComponent(JSON.stringify({ since }));
  const response = await fetch(`${api}/rounds.list?input=${input}`, { signal: AbortSignal.timeout(120_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.result?.data) {
    throw new Error(`crawler API rounds.list: HTTP ${response.status} ${body?.error?.message ?? ''}`.trim());
  }
  log.info({ rounds: body.result.data.rounds.length, readAt: body.result.data.readAt }, 'crawler rounds read');
  return body.result.data;
}

/** Unfinished rounds are left out; they are sent once their last product's first run has settled. */
export function crawlerReports(answer, { crawler, partialShare }) {
  return answer.rounds.filter((round) => round.finishedAt).map((round) => report(round, { crawler, partialShare }));
}

function report(round, { crawler, partialShare }) {
  const { products, brandScans, lists, pushed } = round;
  const share = products.targets ? products.review / products.targets : 0;
  const partial = share > partialShare;
  return {
    source: round.channel,
    runId: round.roundId,
    ...(pushed.runIds.length ? { ingestRunIds: pushed.runIds } : {}),
    server: SERVER[round.channel] ?? 'server-1',
    crawler,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    status: partial ? 'partial' : 'completed',
    // Marketplace and DTC ingest runs are all sent as partial: a round never proves a listing's absence.
    scope: 'partial',
    counts: {
      targets: products.targets,
      fetched: products.completed,
      failed: products.review,
      pushed: pushed.verified,
    },
    breakdown: {
      brand_scans: brandScans,
      product_lists: lists,
      products_open_after_requeue: { products: products.open },
      supply_smart_push: { verified: pushed.verified, failed: pushed.failed, in_flight: pushed.sent, ingest_runs: pushed.runIds.length },
    },
    ...(partial
      ? {
          error: {
            code: 'products_in_review',
            message: `${products.review} of ${products.targets} products ended in Review (${(share * 100).toFixed(1)}%); ` +
              `${brandScans.review} brand scans in Review`,
          },
        }
      : {}),
  };
}
