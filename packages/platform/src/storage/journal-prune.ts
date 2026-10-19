import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { emptyReport, type JournalPruneReport } from "./journal-prune-report.js";
import type { ListedObject } from "./r2-objects.js";

export type { JournalPruneReport } from "./journal-prune-report.js";

/**
 * Owner 2026-10-19: the original product pages (`OriginalHtmlArchive`, `v3/<channel>-html/<operation>/…`) are read
 * from R2 only, so this machine's copies go once R2 holds the same bytes. Other journal folders are read locally
 * (plans, label files, claims) and are never pruned.
 */
export const JOURNAL_HTML_PREFIXES = [
  "v3/amazon-html",
  "v3/swanson-html",
  "v3/gnc-html",
  "v3/costco-html",
  "v3/wholefoods-html",
] as const;

const STAGING = ".pending-";
const EXAMPLES = 20;
const FOLDER_CONCURRENCY = 8;

export interface JournalRemote {
  list(prefix: string, signal: AbortSignal): AsyncIterable<ListedObject>;
}

export interface JournalPruneInput {
  /** The worker's `storage.journalRoot`. */
  root: string;
  prefixes: readonly string[];
  /** Files younger than this stay, whatever R2 holds. */
  minAgeMs: number;
  /** False previews: everything is checked and counted, nothing is removed. */
  removeFiles: boolean;
}

/**
 * Removes local journal copies whose R2 object has the same key, size and MD5 (the ETag of a single-part upload).
 * A file missing from R2 or different there stays and is reported; a failed folder is reported and skipped.
 */
export async function pruneJournal(
  input: JournalPruneInput,
  deps: { remote: JournalRemote; now: () => Date },
  signal: AbortSignal,
): Promise<JournalPruneReport> {
  const prefixes = input.prefixes.map((prefix) => ObjectKeySchema.parse(prefix));
  const report = emptyReport(input.removeFiles, deps.now());
  const cutoff = deps.now().getTime() - input.minAgeMs;
  const folders = walk(input.root, prefixes, signal);
  const runner = async () => {
    for await (const folder of folders) {
      report.folders += 1;
      try {
        await pruneFolder({ ...folder, cutoff, removeFiles: input.removeFiles }, deps.remote, {
          report,
          signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        report.failedFolders += 1;
        example(report.examples.failed, `${folder.key}: ${String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: FOLDER_CONCURRENCY }, runner));
  report.finishedAt = deps.now().toISOString();
  return report;
}

interface Folder {
  key: string;
  path: string;
}

async function* walk(
  root: string,
  prefixes: string[],
  signal: AbortSignal,
): AsyncGenerator<Folder> {
  const pending: Folder[] = prefixes.map((key) => ({ key, path: join(root, key) }));
  for (let folder = pending.pop(); folder; folder = pending.pop()) {
    signal.throwIfAborted();
    const entries = await readdir(folder.path, { withFileTypes: true }).catch(missingIsEmpty);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push({ key: `${folder.key}/${entry.name}`, path: join(folder.path, entry.name) });
      }
    }
    if (entries.some((entry) => entry.isFile())) {
      yield folder;
    }
  }
}

interface PruneFolder extends Folder {
  cutoff: number;
  removeFiles: boolean;
}

interface LocalFile {
  name: string;
  size: number;
  ino: number;
}

async function pruneFolder(
  folder: PruneFolder,
  remote: JournalRemote,
  at: { report: JournalPruneReport; signal: AbortSignal },
): Promise<void> {
  const entries = await readdir(folder.path, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(STAGING));
  const staging = entries.filter((entry) => entry.isFile() && entry.name.startsWith(STAGING));
  const old = await oldFiles(folder, files, at.report);
  if (old.length === 0) {
    return;
  }
  const removed = await removeSaved(folder, old, { ...at, remote });
  const stagingRemoved = await removeStaging(folder, staging, removed);
  at.report.stagingRemoved += stagingRemoved;
  at.report.stagingKept += staging.length - stagingRemoved;
  const onlyFiles = entries.length === files.length + staging.length;
  const emptied = removed.size === files.length && stagingRemoved === staging.length;
  if (folder.removeFiles && onlyFiles && emptied) {
    // A folder something wrote into meanwhile is not empty and stays.
    await rmdir(folder.path).then(
      () => (at.report.foldersRemoved += 1),
      () => undefined,
    );
  }
}

async function oldFiles(
  folder: PruneFolder,
  files: { name: string }[],
  report: JournalPruneReport,
): Promise<LocalFile[]> {
  const old = [];
  for (const { name } of files) {
    const stat = await lstat(join(folder.path, name));
    if (stat.mtimeMs > folder.cutoff) {
      report.young += 1;
    } else {
      old.push({ name, size: stat.size, ino: stat.ino });
    }
  }
  report.files += files.length;
  return old;
}

/** The inodes of the copies R2 holds byte for byte, removed unless this is a preview. */
async function removeSaved(
  folder: PruneFolder,
  old: LocalFile[],
  at: { report: JournalPruneReport; signal: AbortSignal; remote: JournalRemote },
): Promise<Set<number>> {
  const { report, signal, remote } = at;
  const listed = new Map<string, ListedObject>();
  for await (const object of remote.list(folder.key, signal)) {
    listed.set(object.key, object);
  }
  const removed = new Set<number>();
  for (const file of old) {
    const key = `${folder.key}/${file.name}`;
    const path = join(folder.path, file.name);
    const saved = listed.get(key);
    if (!saved) {
      report.notInR2 += 1;
      example(report.examples.notInR2, key);
    } else if (saved.byteSize !== file.size || saved.etag !== (await md5(path, signal))) {
      report.differs += 1;
      example(report.examples.differs, key);
    } else {
      if (folder.removeFiles) {
        await unlink(path);
      }
      removed.add(file.ino);
      report.removed += 1;
      report.removedBytes += file.size;
    }
  }
  return removed;
}

/** Staging links share their file's inode; any other staging file stays. */
async function removeStaging(
  folder: PruneFolder,
  staging: { name: string }[],
  removed: Set<number>,
): Promise<number> {
  let count = 0;
  for (const { name } of staging) {
    const path = join(folder.path, name);
    if (removed.has((await lstat(path)).ino)) {
      if (folder.removeFiles) {
        await unlink(path);
      }
      count += 1;
    }
  }
  return count;
}

async function md5(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function example(list: string[], value: string): void {
  if (list.length < EXAMPLES) {
    list.push(value);
  }
}

function missingIsEmpty(error: unknown): [] {
  if ((error as { code?: string }).code === "ENOENT") {
    return [];
  }
  throw error;
}
