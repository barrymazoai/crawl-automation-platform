import { withCause } from "../errors/with-cause.js";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactRefSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { artifactErrors } from "./artifact-errors.js";
import type { LocalCopies } from "./artifact-types.js";
import { readFileCopy } from "./file-copy-reader.js";
import { verifyBytes } from "./integrity.js";

const codeIs = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** Content-addressed cache in a trusted runtime directory; ownership remains in the ref. */
export class FileCopies implements LocalCopies {
  private constructor(
    private readonly root: string,
    private readonly maxBytes: number,
  ) {}

  static async open(root: string, maxBytes = 32 * 1024 * 1024): Promise<FileCopies> {
    if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw artifactErrors.create("ARTIFACT.SCOPE");
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) {
      throw artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE");
    }
    return new FileCopies(await realpath(root), maxBytes);
  }

  private path(raw: ArtifactRef): string {
    return join(this.root, `${ArtifactRefSchema.parse(raw).sha256}.blob`);
  }

  async read(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array | null> {
    signal.throwIfAborted();
    if (ref.byteSize > this.maxBytes) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    let file;
    try {
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      file = await open(this.path(ref), flags);
    } catch (error) {
      if (codeIs(error, "ENOENT")) {
        // ENOENT means no local copy exists; the caller may inspect the remote store.
        return null;
      }
      throw withCause(artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE"), error);
    }
    try {
      return await readFileCopy(file, ref, { maxBytes: this.maxBytes, signal });
    } finally {
      await file.close();
    }
  }

  async retain(ref: ArtifactRef, raw: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (raw.byteLength > this.maxBytes) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    const bytes = Buffer.from(raw);
    verifyBytes(ref, bytes, this.maxBytes);
    const target = this.path(ref);
    const scratch = join(this.root, `.staging-${randomUUID()}`);
    const file = await open(scratch, "wx", 0o600);
    let published = false;
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      signal.throwIfAborted();
      await this.publishCopy({ scratch, target, ref }, signal);
      published = true;
    } finally {
      await file.close();
      // Failed publication retains staging evidence; remove only our verified staging link.
      if (published) {
        await unlink(scratch);
      }
    }
  }

  private async publishCopy(
    paths: { scratch: string; target: string; ref: ArtifactRef },
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await link(paths.scratch, paths.target);
    } catch (error) {
      if (!codeIs(error, "EEXIST")) {
        throw error;
      }
      if (!(await this.read(paths.ref, signal))) {
        throw withCause(artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE"), error);
      }
    }
  }
}
