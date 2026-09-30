import { mkdir, lstat, open, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type FixedLanePool, type LaneGrant, LanePoolError } from "./lane-pool.js";

export interface OwnedSourceProcess { readonly pid: number; stop(): Promise<boolean> }
export interface OwnedBrowser extends OwnedSourceProcess {
  readonly config: { endpoint: string; instanceId: string; sessionId: string };
}
export interface SourceWorkerSpec { entry: string; env: Record<string, string>; args?: string[] }
export interface SourceProcessDriver {
  browser(input: { grant: LaneGrant; proxyUrl: string; root: string }): Promise<OwnedBrowser>;
  worker(input: { spec: SourceWorkerSpec; root: string }): Promise<OwnedSourceProcess>;
}
const fail = () => new LanePoolError("NETWORK.LANE_LEASE_INVALID");
/** Host runtime ownership, independent of business Workflow results. This object never calls a model,
 * switches Clash or retries a task. Intent-before-launch + no implicit process adoption after restart.
 */
export class LaneSession {
  readonly #workers = new Map<string, { kind: "capture" | "files"; files: string[]; process?: OwnedSourceProcess; closed: boolean }>();
  #busy = false;
  #captureClosed = false;
  private constructor(readonly grant: LaneGrant, readonly proxyUrl: string, readonly browser: OwnedBrowser,
    readonly root: string, private readonly pool: FixedLanePool, private readonly driver: SourceProcessDriver) {}
  static async open(input: { ownerId: string; sessionsRoot: string; endpoints: Readonly<Record<string, string>> },
    pool: FixedLanePool, driver: SourceProcessDriver, signal: AbortSignal) {
    if (!isAbsolute(input.sessionsRoot)) throw fail();
    const stat = await lstat(input.sessionsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) throw fail();
    // Admission persists before any process creation. Lost responses preserve, never replace the lease.
    const grant = await pool.acquire(input.ownerId, signal), proxyUrl = input.endpoints[grant.laneId];
    if (!proxyUrl) throw fail();
    const u = new URL(proxyUrl);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw fail();
    const root = join(input.sessionsRoot, grant.sessionId);
    try { await mkdir(root, { mode: 0o700 }); } catch { throw fail(); } // Never adopt/relaunch an unknown old owner.
    await record(root, "browser-intent", { grant, proxyUrl });
    let browser: OwnedBrowser | undefined;
    try {
      signal.throwIfAborted();
      browser = await driver.browser({ grant, proxyUrl, root });
      if (browser.config.sessionId !== grant.sessionId) throw fail();
      await record(root, "browser-ready", { pid: browser.pid, config: browser.config });
      signal.throwIfAborted();
      return new LaneSession(grant, proxyUrl, browser, root, pool, driver);
    } catch {
      // A failed launch adapter must also clean up its own partial launch; held lease records the uncertainty.
      await browser?.stop().catch(() => false);
      throw fail();
    }
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.#busy) throw new LanePoolError("NETWORK.LANE_BUSY"); this.#busy = true;
    try { return await fn(); } finally { this.#busy = false; }
  }
  async planFiles(operationIds: string[]) {
    return this.exclusive(() => this.pool.retainFiles(this.grant, operationIds));
  }
  async startWorker(id: string, kind: "capture" | "files", spec: SourceWorkerSpec, files: string[] = []) {
    return this.exclusive(async () => {
      if (!/^[a-z][a-z0-9-]{0,79}$/.test(id) || this.#workers.has(id) || !isAbsolute(spec.entry) ||
        (kind === "capture" && (this.#captureClosed || files.length !== 0)) ||
        (kind === "files" && (!files.length || new Set(files).size !== files.length))) throw fail();
      if (kind === "capture") await this.pool.assertHeld(this.grant);
      else {
        for (const op of files) {
          if ([...this.#workers.values()].some(w => w.files.includes(op))) throw fail();
          await this.pool.assertHeld(this.grant, op); // Must already have a durable file plan.
        }
      }
      const workerRoot = join(this.root, id); await mkdir(workerRoot, { mode: 0o700 });
      const item: { kind: "capture" | "files"; files: string[]; process?: OwnedSourceProcess; closed: boolean } = {kind, files:[...files], closed:false};
      this.#workers.set(id, item); // Starting/unknown is occupied, not permission to try again.
      await record(workerRoot, "launch-intent", { id, kind, files, entry: spec.entry });
      item.process = await this.driver.worker({ spec, root: workerRoot });
      await record(workerRoot, "ready", { pid: item.process.pid });
      return { pid: item.process.pid };
    });
  }
  private async stopWorker(id: string) {
    const worker = this.#workers.get(id); if (!worker) throw fail();
    if (worker.closed) return;
    if (!worker.process || !await worker.process.stop()) throw fail();
    await record(join(this.root, id), "stopped", { pid: worker.process.pid });
    // Failed/terminated business work is NOT success; only its network/process occupancy is released.
    for (const operationId of worker.files) await this.pool.closeFile(this.grant, operationId);
    worker.closed = true;
  }
  async closeFileWorker(id: string) {
    return this.exclusive(async () => {
      if (this.#workers.get(id)?.kind !== "files") throw fail(); await this.stopWorker(id);
    });
  }
  async closeCapture() {
    return this.exclusive(async () => {
      if (this.#captureClosed) return;
      for (const [id, worker] of this.#workers) if (worker.kind === "capture") await this.stopWorker(id);
      if (!await this.browser.stop()) throw fail();
      await record(this.root, "browser-stopped", { pid: this.browser.pid });
      await this.pool.closeBrowser(this.grant); // File holds remain even though Chrome is gone.
      this.#captureClosed = true;
    });
  }
  /** Release Activity processes while the operator inspects the same browser.
   * The browser/profile/lane remain owned; this is not a released network slot. */
  async stopCaptureWorkers() {
    return this.exclusive(async()=>{
      for(const [id,worker] of this.#workers)if(worker.kind==="capture")await this.stopWorker(id);
    });
  }
  async closeAll() {
    // Attempt both categories even if one cleanup is unknown, but never silently declare a released lane.
    const errors: unknown[] = [];
    for (const [id,w] of this.#workers) if (w.kind === "files") try { await this.closeFileWorker(id); } catch(e) { errors.push(e); }
    try { await this.closeCapture(); } catch(e) { errors.push(e); }
    if (errors.length) throw fail();
  }
}
async function record(root: string, name: string, value: unknown) {
  const path = join(root, `${name}.json`);
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    if (process.platform !== "win32") { const dir = await open(root,"r"); try { await dir.sync(); } finally { await dir.close(); } }
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isDeepStrictEqual(JSON.parse(await readFile(path,"utf8")),value)) throw fail();
  }
}
