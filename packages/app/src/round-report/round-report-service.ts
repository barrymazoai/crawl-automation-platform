import {
  RoundQuerySchema,
  type CrawlRound,
  type RoundBatchRow,
  type RoundQuery,
  type RoundPushRow,
  type RoundReader,
  type RoundScanRow,
  type RoundSnapshot,
} from "./round-report-model.js";

/** Read-only round summaries per channel, oldest first (KAN-229). Supply Smart counts new products and brands. */
export class RoundReportService {
  constructor(private readonly reader: RoundReader) {}

  async rounds(raw: unknown) {
    const query = RoundQuerySchema.parse(raw);
    const snapshot = await this.reader.read({ since: query.since, channel: query.channel });
    return {
      query,
      readAt: snapshot.readAt,
      basis: {
        round:
          "a burst of product lists: a brand-scan list, or a hand list of at least startListItems products, " +
          "created more than gapHours after the previous round's last start begins a new round",
        window:
          "[startedAt, next round's startedAt): lists, scans and pushes are counted by their time",
        products:
          "queue items of the round's lists by their current state; a requeued item counts once",
        pushed:
          "product_sync rows by their latest ingest run; a later resend moves a row to the later run",
      },
      rounds: roundsOf(snapshot, query),
    };
  }
}

export function roundsOf(snapshot: RoundSnapshot, query: RoundQuery): CrawlRound[] {
  const channels = new Set([
    ...snapshot.batches.map((row) => row.channel),
    ...snapshot.scans.map((row) => row.channel),
  ]);
  return [...channels].sort().flatMap((channel) => channelRounds(snapshot, query, channel));
}

function channelRounds(snapshot: RoundSnapshot, query: RoundQuery, channel: string): CrawlRound[] {
  const batches = snapshot.batches.filter((row) => row.channel === channel);
  const scans = snapshot.scans.filter((row) => row.channel === channel);
  const pushes = snapshot.pushes.filter((row) => row.channel === channel);
  const starts = roundStarts(
    [
      ...scans.map((scan) => scan.requestedAt),
      ...batches.filter((batch) => startsRound(batch, query)).map((batch) => batch.createdAt),
    ],
    query.gapHours,
  );
  return starts.map((startedAt, index) => {
    const windowEnd = starts[index + 1] ?? null;
    const inside = (at: string) => at >= startedAt && (windowEnd === null || at < windowEnd);
    return round({
      channel,
      startedAt,
      windowEnd,
      batches: batches.filter((row) => inside(row.createdAt)),
      scans: scans.filter((row) => inside(row.requestedAt)),
      pushes: pushes.filter((row) => inside(row.at)),
    });
  });
}

function startsRound(batch: RoundBatchRow, query: RoundQuery) {
  return batch.kind === "scan" || (batch.kind === "list" && batch.items >= query.startListItems);
}

/** Each start more than gapHours after the previous start opens a round; the rest belong to the open one. */
function roundStarts(times: string[], gapHours: number) {
  const starts: string[] = [];
  let last: number | null = null;
  for (const at of [...times].sort()) {
    const time = Date.parse(at);
    if (last === null || time - last > gapHours * 3_600_000) {
      starts.push(new Date(time).toISOString());
    }
    last = time;
  }
  return starts;
}

const sum = <T>(rows: T[], pick: (row: T) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

function round(input: {
  channel: string;
  startedAt: string;
  windowEnd: string | null;
  batches: RoundBatchRow[];
  scans: RoundScanRow[];
  pushes: RoundPushRow[];
}): CrawlRound {
  const { channel, startedAt, windowEnd, batches, scans, pushes } = input;
  const brandScans = scanCounts(scans);
  return {
    channel,
    roundId: `${channel}-${startedAt.slice(0, 16)}`,
    startedAt,
    finishedAt: finishedAt(batches, scans),
    windowEnd,
    brandScans,
    lists: {
      scan: batches.filter((row) => row.kind === "scan").length,
      revisit: batches.filter((row) => row.kind === "revisit").length,
      list: batches.filter((row) => row.kind === "list").length,
    },
    products: {
      targets: sum(batches, (row) => row.open + row.completed + row.review),
      completed: sum(batches, (row) => row.completed),
      review: sum(batches, (row) => row.review),
      open: sum(batches, (row) => row.open),
    },
    pushed: {
      verified: sum(pushes, (row) => row.verified),
      failed: sum(pushes, (row) => row.failed),
      sent: sum(pushes, (row) => row.sent),
      runIds: pushes.map((row) => row.runId).sort(),
    },
  };
}

function scanCounts(scans: RoundScanRow[]): CrawlRound["brandScans"] {
  const state = (name: RoundScanRow["state"]) => scans.filter((scan) => scan.state === name).length;
  return {
    total: scans.length,
    sources: new Set(scans.map((scan) => scan.sourceId)).size,
    complete: state("complete"),
    partial: state("partial"),
    review: state("review"),
    cancelled: state("cancelled"),
    open: scans.filter((scan) => scan.finishedAt === null).length,
  };
}

/** The last first run or scan to settle, once nothing of the round is still waiting for its first result. */
function finishedAt(batches: RoundBatchRow[], scans: RoundScanRow[]) {
  if (sum(batches, (row) => row.firstOpen) > 0 || scans.some((scan) => scan.finishedAt === null)) {
    return null;
  }
  const last = [
    ...batches.flatMap((row) => (row.firstSettledAt ? [row.firstSettledAt] : [])),
    ...scans.flatMap((scan) => (scan.finishedAt ? [scan.finishedAt] : [])),
  ]
    .sort()
    .at(-1);
  return last ? new Date(last).toISOString() : null;
}
