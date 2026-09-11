import { readFile, mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
/** Test-only shared-disk stand-in for R2. Never included in production exports. */
export class FixtureObjects implements ObjectStore {
  constructor(private readonly root: string) {}
  async read(key: string, max: number, signal: AbortSignal) {
    signal.throwIfAborted();
    try { const b = await readFile(join(this.root, sha256(Buffer.from(key)))); if (b.length > max) throw Error("fixture size"); return b; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async create(key: string, bytes: Uint8Array, _type: string, signal: AbortSignal) {
    signal.throwIfAborted(); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, sha256(Buffer.from(key))), scratch = join(this.root, `pending-${randomUUID()}`);
    const file = await open(scratch, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(scratch, target); return "created" as const; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists" as const; throw e; }
    finally { await unlink(scratch); }
  }
}
