import { hostname } from "node:os";
import { execa } from "execa";
import { EgoSettingsSchema, type EgoSettings } from "./ego-settings.js";

/** A round's CLI starts right after its identity is recorded; anything started later is another round's. */
const CLI_START_GRACE_MS = 60_000;

/**
 * Proof that a round's CLI is gone when its own exit receipt was lost (worker shutdown mid-round): no `ego-browser`
 * process on this host started early enough to be that round's CLI. `etime` is locale-independent, unlike `lstart`.
 * Returns null while one may still be running; the page check that follows is unchanged.
 */
export async function egoCliAbsent(
  settings: EgoSettings,
  recordedAt: Date,
): Promise<Record<string, unknown> | null> {
  const { cliPath } = EgoSettingsSchema.parse(settings);
  const now = Date.now();
  const { stdout } = await execa("ps", ["-axo", "etime=,command="], { timeout: 5_000 });
  const startedBy = recordedAt.getTime() + CLI_START_GRACE_MS;
  const survivor = stdout.split("\n").some((line) => {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!match?.[2]?.startsWith(cliPath)) {
      return false;
    }
    return now - elapsedMs(match[1] ?? "") <= startedBy;
  });
  if (survivor) {
    return null;
  }
  return {
    kind: "browser-cli-absent",
    host: hostname(),
    cliPath,
    startedBy: new Date(startedBy).toISOString(),
    observedAt: new Date(now).toISOString(),
  };
}

/** `[[dd-]hh:]mm:ss`; an unreadable value counts as a long-running process. */
function elapsedMs(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000
  );
}
