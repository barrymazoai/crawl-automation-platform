import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Owner 2026-11-15: the workers' content-addressed copies (`FileCopies`, `<sha256>.blob`) had no eviction and grew
 * about 3G a day on Server 一. A copy is read again from R2 when it is missing, so a copy last written more than the
 * maximum age ago goes. Staging files (`.staging-*`, a publication that stopped before R2) and anything else stay.
 */
const COPY = /^[0-9a-f]{64}\.blob$/;

export interface CachePruneInput {
  /** The workers' `storage.cacheRoot`. */
  root: string;
  /** A copy written within this age stays. */
  maxAgeMs: number;
  /** False previews: everything is counted, nothing is removed. */
  removeFiles: boolean;
}

/** What one cache prune checked and removed (or, in a preview, would remove). */
export interface CachePruneReport {
  /** `<sha256>.blob` copies seen. */
  files: number;
  removed: number;
  removedBytes: number;
  /** Copies written within the maximum age. */
  young: number;
  /** Staging and any other entries, never touched. */
  kept: number;
}

export async function pruneCache(
  input: CachePruneInput,
  deps: { now: () => Date },
  signal: AbortSignal,
): Promise<CachePruneReport> {
  const report: CachePruneReport = { files: 0, removed: 0, removedBytes: 0, young: 0, kept: 0 };
  const cutoff = deps.now().getTime() - input.maxAgeMs;
  const directory = await opendir(input.root).catch(missingIsNull);
  if (!directory) {
    return report;
  }
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (!entry.isFile() || !COPY.test(entry.name)) {
      report.kept += 1;
      continue;
    }
    report.files += 1;
    const path = join(input.root, entry.name);
    const stat = await lstat(path).catch(missingIsNull);
    if (!stat) {
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      report.young += 1;
      continue;
    }
    // A reader that already opened the copy finishes; a later one finds none and reads R2.
    if (input.removeFiles && !(await unlink(path).then(() => true, missingIsFalse))) {
      continue;
    }
    report.removed += 1;
    report.removedBytes += stat.size;
  }
  return report;
}

function missingIsNull(error: unknown): null {
  if ((error as { code?: string }).code === "ENOENT") {
    return null;
  }
  throw error;
}

function missingIsFalse(error: unknown): false {
  missingIsNull(error);
  return false;
}
