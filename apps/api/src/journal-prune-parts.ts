import { JournalPruneService } from "@crawl-automation/app";
import { createR2Objects, pruneJournal, type Logger } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";

/** The journal prune when this API is configured for it; its own R2 client lists, it never writes. */
export function journalPruneService(parts: { config: ApiConfig; log: Logger }) {
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
  return new JournalPruneService({
    prune: (removeFiles, signal) =>
      pruneJournal({ ...input, removeFiles }, { remote: r2.store, now: () => new Date() }, signal),
    log: parts.log.child({ service: "journal-prune" }),
    intervalMs: settings.intervalMinutes === null ? null : settings.intervalMinutes * 60_000,
  });
}
