import type pg from "pg";
import { ExecutionIdSchema, ReviewListQuerySchema, type ReviewListQuery, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { digest, parseRecord, publicRecord } from "./codec.js";
import { ReviewError, type ReviewReader, type PrivateReviewReader, type ReviewWriter } from "./ports.js";
type Row = {
    review_id: string;
    record_hash: string;
    record: unknown;
    registered_at: Date;
};
export class PostgresReviews implements ReviewReader, PrivateReviewReader, ReviewWriter {
    constructor(private readonly db: Pick<pg.Pool, "query">) { }
    private validate(row: Row): ReviewRecord {
        try {
            const record = parseRecord(row.record);
            if (record.reviewId !== row.review_id || digest(record) !== row.record_hash)
                throw Error();
            return record;
        }
        catch {
            throw new ReviewError("REVIEW.INTEGRITY");
        }
    }
    private async row(reviewId: string): Promise<Row | null> {
        ExecutionIdSchema.parse(reviewId);
        try {
            return (await this.db.query<Row>("SELECT * FROM public.review_record WHERE review_id=$1", [reviewId])).rows[0] ?? null;
        }
        catch {
            throw new ReviewError("REVIEW.UNAVAILABLE");
        }
    }
    async read(reviewId: string): Promise<ReviewRecord | null> { const row = await this.row(reviewId); return row ? this.validate(row) : null; }
    async get(reviewId: string) { const row = await this.row(reviewId); return row ? publicRecord(this.validate(row), row.registered_at.toISOString()) : null; }
    async append(raw: ReviewRecord) {
        const record = parseRecord(raw), hash = digest(record);
        try {
            await this.db.query(`INSERT INTO public.review_record(review_id,record_hash,record) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(review_id) DO NOTHING`, [record.reviewId, hash, JSON.stringify(record)]);
            const stored = await this.read(record.reviewId);
            if (!stored)
                throw new ReviewError("REVIEW.REGISTRATION_UNKNOWN");
            if (digest(stored) !== hash)
                throw new ReviewError("REVIEW.CONFLICT");
            return { reviewId: record.reviewId, recordHash: hash, registered: true as const };
        }
        catch (error) {
            if (error instanceof ReviewError && error.code === "REVIEW.CONFLICT")
                throw error;
            // Even a committed INSERT with a dropped response is NOT acknowledged success.
            throw new ReviewError("REVIEW.REGISTRATION_UNKNOWN");
        }
    }
    async list(raw: ReviewListQuery) {
        const query = ReviewListQuerySchema.parse(raw), params: unknown[] = [], where: string[] = [];
        // Ordering by immutable opaque ID avoids precision loss from timestamp cursors.
        if (query.before) {
            params.push(query.before);
            where.push(`review_id < $${params.length}`);
        }
        for (const key of ["requestId", "operationId", "category", "code", "stage", "executionFact", "blockedBy", "brandId", "sourceId"] as const) {
            if (query[key] === undefined)
                continue;
            params.push(query[key]);
            const group = key === "brandId" || key === "sourceId" ? "observation" : "failure";
            where.push(`record->'${group}'->>'${key}' = $${params.length}`);
        }
        params.push(query.limit + 1);
        try {
            const rows = (await this.db.query<Row>(`SELECT * FROM public.review_record ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY review_id DESC LIMIT $${params.length}`, params)).rows;
            const items = rows.slice(0, query.limit).map(row => publicRecord(this.validate(row), row.registered_at.toISOString()));
            return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.reviewId : null };
        }
        catch (error) {
            if (error instanceof ReviewError)
                throw error;
            throw new ReviewError("REVIEW.UNAVAILABLE");
        }
    }
    async summary() {
        try {
            const rows = (await this.db.query<{
                category: string;
                count: string;
            }>("SELECT record->'failure'->>'category' AS category,count(*)::text AS count FROM public.review_record GROUP BY 1 ORDER BY 1")).rows;
            const categories = rows.map(row => ({ category: row.category, count: Number(row.count) }));
            return { total: categories.reduce((n, row) => n + row.count, 0), categories };
        }
        catch {
            throw new ReviewError("REVIEW.UNAVAILABLE");
        }
    }
}
