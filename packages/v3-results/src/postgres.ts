import type pg from "pg";
import { ExecutionIdSchema, type OcrRegistration } from "@crawl-automation/v3-contracts";
import { recordHash, validateRecord } from "./codec.js";
import { ResultError, type ResultRegistry } from "./ports.js";
export class PostgresResultRegistry implements ResultRegistry {
    constructor(private readonly db: Pick<pg.Pool, "query">) { }
    async read(operationId: string): Promise<OcrRegistration | null> {
        ExecutionIdSchema.parse(operationId);
        try {
            const rows = (await this.db.query("SELECT record,record_hash FROM public.processing_result WHERE operation_id=$1", [operationId])).rows;
            if (!rows[0])
                return null;
            const record = validateRecord(rows[0].record);
            if (record.input.operationId !== operationId || recordHash(record) !== rows[0].record_hash)
                throw new ResultError("RESULT.INTEGRITY");
            return record;
        }
        catch (e) {
            if (e instanceof ResultError)
                throw e;
            throw new ResultError("RESULT.UNAVAILABLE");
        }
    }
    async register(raw: OcrRegistration): Promise<void> {
        const record = validateRecord(raw), hash = recordHash(record);
        try {
            await this.db.query(`INSERT INTO public.processing_result(operation_id,record_hash,record) VALUES ($1,$2,$3::jsonb)
        ON CONFLICT(operation_id) DO NOTHING`, [record.input.operationId, hash, JSON.stringify(record)]);
            const existing = await this.read(record.input.operationId);
            if (!existing || recordHash(existing) !== hash)
                throw new ResultError("RESULT.CONFLICT");
        }
        catch (e) {
            if (e instanceof ResultError && e.code === "RESULT.CONFLICT")
                throw e;
            throw new ResultError("RESULT.REGISTRATION_UNKNOWN");
        }
    }
}
