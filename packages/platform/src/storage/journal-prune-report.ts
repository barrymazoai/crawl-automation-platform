/** What one journal prune checked and removed (or, in a preview, would remove). */
export interface JournalPruneReport {
  removeFiles: boolean;
  startedAt: string;
  finishedAt: string;
  folders: number;
  /** Files checked, staging links not included. */
  files: number;
  /** Files whose R2 copy matched (removed, or removable in a preview). */
  removed: number;
  removedBytes: number;
  /** Files in active folders: written within the minimum age, or still being written. */
  young: number;
  /** Folders with such a write; nothing in them is checked or removed. */
  activeFolders: number;
  notInR2: number;
  differs: number;
  /** `.pending-*` staging links of removed files; any other staging file stays. */
  stagingRemoved: number;
  stagingKept: number;
  foldersRemoved: number;
  failedFolders: number;
  examples: { notInR2: string[]; differs: string[]; failed: string[] };
}

export function emptyReport(removeFiles: boolean, now: Date): JournalPruneReport {
  return {
    removeFiles,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    folders: 0,
    files: 0,
    removed: 0,
    removedBytes: 0,
    young: 0,
    activeFolders: 0,
    notInR2: 0,
    differs: 0,
    stagingRemoved: 0,
    stagingKept: 0,
    foldersRemoved: 0,
    failedFolders: 0,
    examples: { notInR2: [], differs: [], failed: [] },
  };
}
