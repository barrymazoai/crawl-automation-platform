import { constants } from "node:fs";
import { mkdir, lstat, open, rename, rmdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { LanePoolError, LanePoolStateSchema, type LanePoolState, type LanePoolStore } from "./lane-pool.js";

/** Host-local filesystem only, not NFS/shared across machines. All processes use the SAME private root.
 * Exclusive mkdir + atomic rename. A crashed writer leaves its lock; never guess a TTL or steal it.
 * Holding leases survive crashes even when the writer lock has already been removed.
 */
export class FileLanePoolStore implements LanePoolStore {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new LanePoolError("NETWORK.LANE_CONFIG");
  }
  async transaction<T>(initial: LanePoolState, change: (state: LanePoolState) => Promise<T>): Promise<T> {
    const dir = await lstat(this.root);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && (dir.mode & 0o077)))
      throw new LanePoolError("NETWORK.LANE_STATE");
    const lock = join(this.root, "writer.lock"), path = join(this.root, "state.json");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new LanePoolError("NETWORK.LANE_BUSY"); }
    let uncertain = false;
    const publish = async (state: LanePoolState) => {
      const data = JSON.stringify({ host: hostname(), state: LanePoolStateSchema.parse(state) });
      if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new LanePoolError("NETWORK.LANE_CAPACITY");
      uncertain = true;
      const temporary = join(this.root, `state-${randomUUID()}.pending`);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      if (process.platform !== "win32") { const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); } }
      uncertain = false;
    };
    try {
      let state: LanePoolState;
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error();
          const doc = JSON.parse(await file.readFile("utf8"));
          if (doc.host !== hostname()) throw Error();
          state = LanePoolStateSchema.parse(doc.state);
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new LanePoolError("NETWORK.LANE_STATE");
        // First creation is explicit; losing an initialized state must not resurrect a fresh pool.
        try { await mkdir(join(this.root, "initialized"), { mode: 0o700 }); }
        catch { throw new LanePoolError("NETWORK.LANE_STATE"); }
        state = structuredClone(initial);
        await publish(state);
      }
      const result = await change(state);
      await publish(state);
      return result;
    } finally {
      // Even failed operations can release a writer lock: no external mutation is performed by state callbacks.
      // If a state publish/fsync fails, retain the lock for explicit recovery (uncertain durable outcome).
      if (!uncertain) await rmdir(lock);
    }
  }
}
