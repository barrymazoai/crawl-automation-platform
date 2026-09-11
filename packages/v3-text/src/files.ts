import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, link } from "node:fs/promises";
import { isAbsolute, join, dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { TextError } from "./ports.js";
/** Node-local immutable evidence. Shared invocation guards MUST use the shared ObjectStore, not this cache. */
export class TextLocalStore implements ObjectStore {
    private constructor(private readonly root: string, private readonly maxBytes = 8388608) { }
    static async open(root: string, maxBytes = 8388608) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new TextError("TEXT.LOCAL_CONFIG");
        if (!isAbsolute(root))
            throw new TextError("TEXT.LOCAL_CONFIG");
        await mkdir(root, { recursive: true, mode: 0o700 });
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new TextError("TEXT.LOCAL_CONFIG");
        return new TextLocalStore(await realpath(root), maxBytes);
    }
    private async path(key: string, create: boolean) {
        const path = join(this.root, ObjectKeySchema.parse(key)), parent = dirname(path);
        let cursor = this.root;
        for (const part of key.split("/").slice(0, -1)) {
            cursor = join(cursor, part);
            if (create) {
                try {
                    await mkdir(cursor, { mode: 0o700 });
                }
                catch (e) {
                    if ((e as {
                        code?: string;
                    }).code !== "EEXIST")
                        throw e;
                }
            }
            const stat = await lstat(cursor);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new TextError("TEXT.LOCAL_CONFIG");
        }
        const actual = await realpath(parent);
        if (actual !== this.root && !actual.startsWith(this.root + sep))
            throw new TextError("TEXT.LOCAL_CONFIG");
        return path;
    }
    async read(key: string, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
        if (!Number.isSafeInteger(max) || max < 1 || max > this.maxBytes)
            throw new TextError("TEXT.OUTPUT_LIMIT");
        signal.throwIfAborted();
        let file;
        try {
            file = await open(await this.path(key, false), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        catch (e) {
            if ((e as {
                code?: string;
            }).code === "ENOENT")
                return null;
            throw e;
        }
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > max)
                throw new TextError("TEXT.OUTPUT_LIMIT");
            const data = Buffer.alloc(max + 1);
            let length = 0;
            while (length < data.length) {
                signal.throwIfAborted();
                const r = await file.read(data, length, data.length - length, length);
                if (!r.bytesRead)
                    break;
                length += r.bytesRead;
            }
            if (length !== stat.size || length > max)
                throw new TextError("TEXT.OUTPUT_LIMIT");
            return data.subarray(0, length);
        }
        finally {
            await file.close();
        }
    }
    async create(key: string, bytes: Uint8Array, _mediaType: string, signal: AbortSignal) {
        signal.throwIfAborted();
        if (bytes.length > this.maxBytes)
            throw new TextError("TEXT.OUTPUT_LIMIT");
        const path = await this.path(key, true), pending = join(dirname(path), `.pending-${randomUUID()}`), file = await open(pending, "wx", 0o600);
        try {
            await file.writeFile(bytes);
            await file.sync();
        }
        finally {
            await file.close();
        }
        signal.throwIfAborted();
        try {
            await link(pending, path);
            return "created" as const;
        }
        catch (e) {
            if ((e as {
                code?: string;
            }).code === "EEXIST")
                return "exists" as const;
            throw e;
        }
        // Keep staging links as evidence too; no automatic successful-task cleanup.
    }
}
