import { hostname } from "node:os";
import { execa } from "execa";
import { elapsedMs } from "../execution/process-elapsed.js";

/** `ps` start times are whole seconds; the recorded start follows the spawn by a moment. */
const START_SLACK_MS = 5_000;

/**
 * Proof that a Codex process group is gone when its own exit receipt was lost (worker shutdown mid-run): neither the
 * recorded process nor any member of its group is still running on this host. A later process that reused the pid
 * is not the recorded one; a group member is always treated as a survivor. Null keeps the permit held.
 */
export async function codexGroupAbsent(identity: {
  pid: number;
  host: string;
  startedAt: string;
}): Promise<Record<string, unknown> | null> {
  if (identity.host !== hostname() || identity.pid <= 0) {
    return null;
  }
  const now = Date.now();
  const startedBy = Date.parse(identity.startedAt) + START_SLACK_MS;
  const { stdout } = await execa("ps", ["-axo", "pid=,pgid=,etime="], { timeout: 5_000 });
  const survivor = stdout.split("\n").some((line) => {
    const [pid, pgid, etime] = line.trim().split(/\s+/);
    if (Number(pgid) === identity.pid && Number(pid) !== identity.pid) {
      return true;
    }
    return Number(pid) === identity.pid && now - elapsedMs(etime ?? "") <= startedBy;
  });
  if (survivor) {
    return null;
  }
  return {
    kind: "codex-process-group-absent",
    host: identity.host,
    pid: identity.pid,
    observedAt: new Date(now).toISOString(),
  };
}
