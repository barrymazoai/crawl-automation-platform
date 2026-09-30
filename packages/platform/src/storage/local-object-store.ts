import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "./object-store.js";
import { storageErrors } from "./storage-errors.js";

const DEFAULT_MAX_BYTES = 8_388_608;
const LIMIT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * This machine's copy of evidence, as immutable files under one private folder. A key is created once (hard link
 * from a synced staging file) and never overwritten. Shared invocation guards must use R2, never this store.
 */
export class LocalObjectStore implements ObjectStore {
  private constructor(
    private readonly root: string,
    private readonly maxBytes: number,
  ) {}

  static async open(root: string, maxBytes = DEFAULT_MAX_BYTES): Promise<LocalObjectStore> {
    const validLimit =
      Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= LIMIT_MAX_BYTES;
    if (!validLimit || !isAbsolute(root)) {
      throw storageErrors.create("STORAGE.LOCAL_CONFIG");
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storageErrors.create("STORAGE.LOCAL_CONFIG");
    }
    return new LocalObjectStore(await realpath(root), maxBytes);
  }

  async read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxBytes) {
      throw storageErrors.create("STORAGE.INVALID_LIMIT");
    }
    signal.throwIfAborted();
    let file;
    try {
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      file = await open(await this.pathFor(key, false), flags);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        // ENOENT means no local copy exists; the caller may inspect the remote store.
        return null;
      }
      throw error;
    }
    try {
      return await readBounded(file, maxBytes, signal);
    } finally {
      await file.close();
    }
  }

  // Exception to the 3-parameter rule: this is the ObjectStore shape R2 and every old worker implement. It becomes
  // one named entry when storage moves fully into the platform and the old stores retire (M8).
  // eslint-disable-next-line max-params
  async create(key: string, bytes: Uint8Array, _mediaType: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (bytes.length > this.maxBytes) {
      throw storageErrors.create("STORAGE.TOO_LARGE");
    }
    const path = await this.pathFor(key, true);
    const pending = join(dirname(path), `.pending-${randomUUID()}`);
    const file = await open(pending, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    // The staging link is kept as evidence too; nothing is cleaned up automatically.
    try {
      await link(pending, path);
      return "created" as const;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        // EEXIST is the successful create-once loser, not a failed write.
        return "exists" as const;
      }
      throw error;
    }
  }

  /** The key's path, every parent a real folder inside the root (created when `create` is true). */
  private async pathFor(key: string, create: boolean): Promise<string> {
    if (!ObjectKeySchema.safeParse(key).success) {
      throw storageErrors.create("STORAGE.INVALID_KEY");
    }
    let cursor = this.root;
    for (const part of key.split("/").slice(0, -1)) {
      cursor = join(cursor, part);
      if (create) {
        await mkdir(cursor, { mode: 0o700 }).catch(ignoreExisting);
      }
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw storageErrors.create("STORAGE.LOCAL_CONFIG");
      }
    }
    const path = join(this.root, key);
    const parent = await realpath(dirname(path));
    if (parent !== this.root && !parent.startsWith(this.root + sep)) {
      throw storageErrors.create("STORAGE.LOCAL_CONFIG");
    }
    return path;
  }
}

function ignoreExisting(error: unknown): void {
  if ((error as { code?: string }).code !== "EEXIST") {
    throw error;
  }
}

async function readBounded(
  file: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > maxBytes) {
    throw storageErrors.create("STORAGE.TOO_LARGE");
  }
  const data = Buffer.alloc(maxBytes + 1);
  let length = 0;
  while (length < data.length) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(data, length, data.length - length, length);
    if (!bytesRead) {
      break;
    }
    length += bytesRead;
  }
  if (length !== stat.size || length > maxBytes) {
    throw storageErrors.create("STORAGE.TOO_LARGE");
  }
  return data.subarray(0, length);
}
