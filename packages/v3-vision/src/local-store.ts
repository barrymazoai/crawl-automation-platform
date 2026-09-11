import { mkdir, open, readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
/** Private local test/pilot store. Not a replacement for cross-node R2 durability/DB registration. */
export class LocalVisionEvidenceStore implements ObjectStore {
  private constructor(private readonly root: string) {}
  static async open(root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error("VISION.PRIVATE_STORE");
    return new LocalVisionEvidenceStore(resolve(root));
  }
  private path(key: string) { return join(this.root, ObjectKeySchema.parse(key)); }
  async read(key: string, limit: number, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const path = this.path(key), s = await lstat(path);
      if (!s.isFile() || s.isSymbolicLink() || s.size > limit) throw Error("VISION.STORE_INVALID");
      const bytes = await readFile(path); if (bytes.length > limit) throw Error("VISION.STORE_LIMIT"); return bytes;
    } catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return null; throw e; }
  }
  async create(key: string, bytes: Uint8Array, _media: string, signal: AbortSignal): Promise<"created" | "exists"> {
    signal.throwIfAborted();
    const path = this.path(key); await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    let f;
    try { f = await open(path, "wx", 0o600); }
    catch (e) { if (e instanceof Error && "code" in e && e.code === "EEXIST") return "exists"; throw e; }
    try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    return "created";
  }
}
