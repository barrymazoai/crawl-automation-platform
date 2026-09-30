import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  Brand,
  Source,
  Summary,
  type Page,
  type CreateBrand,
  type UpdateBrand,
  type CreateSource,
  type UpdateSource,
  type ToggleSource,
  type ListQuery,
} from "@crawl-automation/v3-contracts";
import type { BrandRepository, Mutation } from "../brands/port.js";
import { ApiError } from "../errors.js";
import { withRequestReceipt } from "./request-receipts.js";

const brandColumns =
  'id,name,note,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
const sourceColumns =
  'id,brand_id AS "brandId",channel,region,url,enabled,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
const databaseTimestamps = z
  .object({ createdAt: z.date(), updatedAt: z.date() })
  .passthrough()
  .transform((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
const brandFromRow = (row: unknown) =>
  Brand.parse(databaseTimestamps.parse(row));
const sourceFromRow = (row: unknown) =>
  Source.parse(databaseTimestamps.parse(row));
function page<T>(items: T[], query: ListQuery): Page<T> {
  return {
    items: items.slice(0, query.limit),
    limit: query.limit,
    offset: query.offset,
    hasMore: items.length > query.limit,
  };
}

export class PostgresBrands implements BrandRepository {
  constructor(private readonly pool: Pool) {}

  private async mutate<T>(
    requestId: string,
    operation: string,
    input: unknown,
    schema: z.ZodType<T>,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<Mutation<T>> {
    return withRequestReceipt(this.pool, requestId, operation, input, schema, run);
  }

  async list(query: ListQuery) {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${brandColumns} FROM brand WHERE strpos(lower(name),lower($1))>0 ORDER BY created_at,id LIMIT $2 OFFSET $3`,
      [query.q, query.limit + 1, query.offset],
    );
    return page(result.rows.map(brandFromRow), query);
  }
  async get(id: string) {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${brandColumns} FROM brand WHERE id=$1`,
      [id],
    );
    if (!result.rows[0])
      throw new ApiError(404, "BRAND_NOT_FOUND", "Brand not found.");
    return brandFromRow(result.rows[0]);
  }
  async listSources(brandId: string, query: ListQuery) {
    await this.get(brandId);
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${sourceColumns} FROM brand_source WHERE brand_id=$1 AND strpos(lower(url),lower($2))>0 ORDER BY created_at,id LIMIT $3 OFFSET $4`,
      [brandId, query.q, query.limit + 1, query.offset],
    );
    return page(result.rows.map(sourceFromRow), query);
  }
  async summary() {
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT (SELECT count(*)::int FROM brand) AS brands,(SELECT count(*)::int FROM brand_source) AS sources,(SELECT count(*)::int FROM brand_source WHERE enabled) AS "enabledSources"',
    );
    return Summary.parse(result.rows[0]);
  }
  create(input: CreateBrand, requestId: string) {
    return this.mutate(
      requestId,
      "brand.create",
      input,
      Brand,
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO brand(name,note) VALUES($1,$2) RETURNING ${brandColumns}`,
          [input.name, input.note],
        );
        return brandFromRow(result.rows[0]);
      },
    );
  }
  update(id: string, input: UpdateBrand, requestId: string) {
    return this.mutate(
      requestId,
      `brand.update:${id}`,
      input,
      Brand,
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `UPDATE brand SET name=$2,note=$3 WHERE id=$1 AND revision=$4 RETURNING ${brandColumns}`,
          [id, input.name, input.note, input.revision],
        );
        if (!result.rows[0]) {
          const exists = (
            await client.query("SELECT 1 FROM brand WHERE id=$1", [id])
          ).rowCount;
          throw new ApiError(
            exists ? 409 : 404,
            exists ? "REVISION_CONFLICT" : "BRAND_NOT_FOUND",
            exists
              ? "Brand changed; reload before editing."
              : "Brand not found.",
          );
        }
        return brandFromRow(result.rows[0]);
      },
    );
  }
  createSource(brandId: string, input: CreateSource, requestId: string) {
    return this.mutate(
      requestId,
      `source.create:${brandId}`,
      input,
      Source,
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO brand_source(brand_id,channel,region,url) VALUES($1,$2,$3,$4) RETURNING ${sourceColumns}`,
          [brandId, input.channel, input.region, input.url],
        );
        return sourceFromRow(result.rows[0]);
      },
    );
  }
  private async sourceResult(
    client: PoolClient,
    row: unknown,
    brandId: string,
    sourceId: string,
  ) {
    if (row) return sourceFromRow(row);
    const exists = (
      await client.query(
        "SELECT 1 FROM brand_source WHERE brand_id=$1 AND id=$2",
        [brandId, sourceId],
      )
    ).rowCount;
    throw new ApiError(
      exists ? 409 : 404,
      exists ? "REVISION_CONFLICT" : "SOURCE_NOT_FOUND",
      exists
        ? "Source changed; reload before editing."
        : "Source not found for this Brand.",
    );
  }
  updateSource(
    brandId: string,
    sourceId: string,
    input: UpdateSource,
    requestId: string,
  ) {
    return this.mutate(
      requestId,
      `source.update:${brandId}:${sourceId}`,
      input,
      Source,
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `UPDATE brand_source SET channel=$3,region=$4,url=$5 WHERE brand_id=$1 AND id=$2 AND revision=$6 RETURNING ${sourceColumns}`,
          [
            brandId,
            sourceId,
            input.channel,
            input.region,
            input.url,
            input.revision,
          ],
        );
        return this.sourceResult(client, result.rows[0], brandId, sourceId);
      },
    );
  }
  toggleSource(
    brandId: string,
    sourceId: string,
    input: ToggleSource,
    requestId: string,
  ) {
    return this.mutate(
      requestId,
      `source.toggle:${brandId}:${sourceId}`,
      input,
      Source,
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `UPDATE brand_source SET enabled=$3 WHERE brand_id=$1 AND id=$2 AND revision=$4 RETURNING ${sourceColumns}`,
          [brandId, sourceId, input.enabled, input.revision],
        );
        return this.sourceResult(client, result.rows[0], brandId, sourceId);
      },
    );
  }
}
