import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactRefSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { ArtifactError, type LocalCopies } from "./ports.js";
import { verifyBytes } from "./integrity.js";

const codeIs = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;

/** Private, trusted runtime directory. Not a path handed over by another Worker. */
export class FileCopies implements LocalCopies {
  private constructor(private readonly root: string, private readonly maxBytes: number) {}
  static async open(root: string, maxBytes = 32 * 1024 * 1024): Promise<FileCopies> {
    if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ArtifactError("ARTIFACT.SCOPE");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new ArtifactError("ARTIFACT.CACHE_UNAVAILABLE");
    return new FileCopies(await realpath(root), maxBytes);
  }
  private path(raw: ArtifactRef): string {
    const ref = ArtifactRefSchema.parse(raw);
    // Content-addressed local copies can share bytes, never product ownership.
    return join(this.root, `${ref.sha256}.blob`);
  }
  async read(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array | null> {
    signal.throwIfAborted();
    if (ref.byteSize > this.maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    let file;
    try { file = await open(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (codeIs(error, "ENOENT")) return null; throw new ArtifactError("ARTIFACT.CACHE_UNAVAILABLE"); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== ref.byteSize) throw new ArtifactError("ARTIFACT.INTEGRITY");
      // Bound allocation even if a local file changes/grows after stat.
      const bytes = Buffer.alloc(ref.byteSize + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const value = bytes.subarray(0, offset);
      verifyBytes(ref, value, this.maxBytes);
      return value;
    } finally { await file.close(); }
  }
  async retain(ref: ArtifactRef, raw: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (raw.byteLength > this.maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    const bytes = Buffer.from(raw);
    verifyBytes(ref, bytes, this.maxBytes);
    const target = this.path(ref), scratch = join(this.root, `.staging-${randomUUID()}`);
    const file = await open(scratch, "wx", 0o600);
    let published = false;
    try {
      await file.writeFile(bytes); await file.sync(); await file.close();
      signal.throwIfAborted();
      try { await link(scratch, target); published = true; }
      catch (error) {
        if (!codeIs(error, "EEXIST")) throw error;
        const existing = await this.read(ref, signal);
        if (!existing) throw new ArtifactError("ARTIFACT.CACHE_UNAVAILABLE");
        published = true;
      }
    } finally {
      await file.close();
      // Remove only this invocation's staging link after verified publication.
      // Failed publication keeps its complete staging evidence for review.
      if (published) await unlink(scratch);
    }
  }
}
