import { PostgresUsageRetention } from "@crawl-automation/adapters";
import { JournalPruneService } from "@crawl-automation/app";
import {
  createR2Objects,
  pruneCache,
  pruneJournal,
  type Database,
  type Logger,
} from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";

type PruneSettings = NonNullable<ApiConfig["journalPrune"]>;

/** The journal prune when this API is configured for it; its own R2 client lists, it never writes. */
export function journalPruneService(parts: { config: ApiConfig; log: Logger; database: Database }) {
  const { journalPrune: settings, storage } = parts.config;
  if (!settings || !storage) {
    return null;
  }
  const r2 = createR2Objects(storage.r2, storage.r2Credentials);
  const input = {
    root: settings.root,
    prefixes: settings.prefixes,
    minAgeMs: settings.minAgeHours * 3_600_000,
  };
  const now = () => new Date();
  const { cache } = settings;
  const usage = usagePass(settings.usage, parts.database, now);
  return new JournalPruneService({
    prune: async (removeFiles, signal) => {
      const report = await pruneJournal(
        { ...input, removeFiles },
        { remote: r2.store, now },
        signal,
      );
      const maxAgeMs = (cache?.maxAgeHours ?? 0) * 3_600_000;
      return {
        ...report,
        ...(cache && {
          cache: await pruneCache({ root: cache.root, maxAgeMs, removeFiles }, { now }, signal),
        }),
        ...(usage && { usage: await usage(removeFiles, signal) }),
      };
    },
    log: parts.log.child({ service: "journal-prune" }),
    intervalMs: settings.intervalMinutes === null ? null : settings.intervalMinutes * 60_000,
  });
}

/** The usage retention pass of the same run, when configured. */
function usagePass(settings: PruneSettings["usage"], database: Database, now: () => Date) {
  if (!settings) {
    return null;
  }
  const retention = new PostgresUsageRetention(database, { now });
  const { kinds, keepDays, maxRowsPerRun: maxRows } = settings;
  return (removeRows: boolean, signal: AbortSignal) =>
    retention.prune({ kinds, keepDays, maxRows, removeRows }, signal);
}
