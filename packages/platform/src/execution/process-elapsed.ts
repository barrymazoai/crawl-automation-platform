/** `ps -o etime` as milliseconds: `[[dd-]hh:]mm:ss`, locale-independent. Unreadable counts as long-running. */
export function elapsedMs(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000
  );
}
