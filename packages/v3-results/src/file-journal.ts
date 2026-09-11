import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionIdSchema, type OcrRegistration } from "@crawl-automation/v3-contracts";
import { recordHash, validateRecord } from "./codec.js";
import { ResultError, type CompletionJournal } from "./ports.js";
const isCode = (e: unknown, code: string) => e instanceof Error && "code" in e && e.code === code;
export class FileCompletionJournal implements CompletionJournal {
    private constructor(private readonly root: string) { }
    static async open(root: string) {
        if (!isAbsolute(root))
            throw new ResultError("RESULT.INTEGRITY");
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (!(await lstat(root)).isDirectory())
            throw new ResultError("RESULT.INTEGRITY");
        return new FileCompletionJournal(await realpath(root));
    }
    private path(id: string) { return join(this.root, `${ExecutionIdSchema.parse(id)}.json`); }
    async read(id: string): Promise<OcrRegistration | null> {
        let file;
        try {
            file = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        catch (e) {
            if (isCode(e, "ENOENT"))
                return null;
            throw new ResultError("RESULT.UNAVAILABLE");
        }
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 1024 * 1024)
                throw new ResultError("RESULT.INTEGRITY");
            const buffer = Buffer.alloc(1024 * 1024 + 1);
            let offset = 0;
            while (offset < buffer.length) {
                const r = await file.read(buffer, offset, buffer.length - offset, offset);
                if (!r.bytesRead)
                    break;
                offset += r.bytesRead;
            }
            if (offset !== stat.size)
                throw new ResultError("RESULT.INTEGRITY");
            const record = validateRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset))));
            if (record.input.operationId !== id)
                throw new ResultError("RESULT.CONFLICT");
            return record;
        }
        catch (e) {
            if (e instanceof ResultError)
                throw e;
            throw new ResultError("RESULT.INTEGRITY");
        }
        finally {
            await file.close();
        }
    }
    async create(raw: OcrRegistration) {
        const record = validateRecord(raw), bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > 1024 * 1024)
            throw new ResultError("RESULT.INTEGRITY");
        const scratch = join(this.root, `.pending-${randomUUID()}`), file = await open(scratch, "wx", 0o600);
        let published = false;
        try {
            await file.writeFile(bytes);
            await file.sync();
            await file.close();
            try {
                await link(scratch, this.path(record.input.operationId));
                published = true;
            }
            catch (e) {
                if (!isCode(e, "EEXIST"))
                    throw e;
                const prior = await this.read(record.input.operationId);
                if (!prior || recordHash(prior) !== recordHash(record))
                    throw new ResultError("RESULT.CONFLICT");
                published = true;
            }
        }
        finally {
            await file.close();
            if (published)
                await unlink(scratch);
        }
    }
}
