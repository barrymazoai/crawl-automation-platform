import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LanePoolError, type LaneGrant } from "./lane-pool.js";

const fail = () => new LanePoolError("NETWORK.LANE_STATE");
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw fail();
}
async function privateJson(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}

/** Host-local persistent browser data, never a task artifact. A crash leaves the lock held:
 * no TTL reclaim, copying live profiles, adopting another Chrome, or deleting browser data.
 */
export async function acquireBrowserProfile(root: string, grant: LaneGrant, proxyUrl: string) {
  if (!isAbsolute(root) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(grant.laneId)) throw fail();
  await privateDirectory(root);
  const laneRoot = join(root, grant.laneId);
  await privateDirectory(laneRoot);
  const lock = join(laneRoot, "owner.json"), token = randomUUID();
  try { await privateJson(lock, { token, sessionId: grant.sessionId, pid: process.pid }); }
  catch { throw fail(); }
  let released = false;
  const release = async () => {
    if (released) return;
    if (JSON.parse(await readFile(lock, "utf8")).token !== token) throw fail();
    await unlink(lock); released = true;
  };
  try {
    const binding = { version: 1, laneId: grant.laneId, route: grant.route, proxyUrl };
    const manifest = join(laneRoot, "binding.json");
    try { await privateJson(manifest, binding); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !isDeepStrictEqual(JSON.parse(await readFile(manifest, "utf8")), binding)) throw fail();
    }
    const path = join(laneRoot, "profile");
    await privateDirectory(path);
    // Even an unmanaged Chrome (or stale native lock) requires inspection before reuse.
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try { await lstat(join(path, name)); throw fail(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return { path, release };
  } catch (error) { await release(); throw error; } // No child has been launched yet.
}
