import {
  appErrors,
  type BrandStore,
  type CreateBrandSchema,
  type CreateSourceSchema,
  type ListSourcesSchema,
  type ToggleSourceSchema,
  type UpdateBrandSchema,
  type UpdateSourceSchema,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import { Brand, Source, type ListQuery, type Page } from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import { oncePerRequest } from "./request-receipt.js";

type Input<Schema extends z.ZodType> = z.infer<Schema>;

const brandColumns = `id, name, note, revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
const sourceColumns = `id, brand_id AS "brandId", channel, region, url, enabled, revision,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function withIsoDates(row: Record<string, unknown>) {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  return { ...row, createdAt: iso(row["createdAt"]), updatedAt: iso(row["updatedAt"]) };
}

const toBrand = (row: unknown) => Brand.parse(withIsoDates(row as Record<string, unknown>));
const toSource = (row: unknown) => Source.parse(withIsoDates(row as Record<string, unknown>));

function page<Item>(rows: Item[], query: ListQuery): Page<Item> {
  const hasMore = rows.length > query.limit;
  return { items: rows.slice(0, query.limit), limit: query.limit, offset: query.offset, hasMore };
}

/** A missing row after a revision-checked update means it was either deleted or changed meanwhile. */
async function missingOrChanged(tx: Queryable, sql: string, values: unknown[]): Promise<never> {
  const exists = (await tx.query(sql, values)).length > 0;
  throw appErrors.create(exists ? "BRAND.REVISION_CONFLICT" : "BRAND.SOURCE_NOT_FOUND");
}

/** Maps Postgres constraint errors to the application's codes. */
function constraintError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") {
    throw appErrors.create("BRAND.DUPLICATE", { cause: error });
  }
  if (code === "23503") {
    throw appErrors.create("BRAND.NOT_FOUND", { cause: error });
  }
  throw error;
}

export class PostgresBrandStore implements BrandStore {
  constructor(private readonly database: Database) {}

  async list(query: ListQuery): Promise<Page<Brand>> {
    const rows = await this.database.query(
      `SELECT ${brandColumns} FROM brand WHERE strpos(lower(name), lower($1)) > 0
       ORDER BY created_at, id LIMIT $2 OFFSET $3`,
      [query.q, query.limit + 1, query.offset],
    );
    return page(rows.map(toBrand), query);
  }

  async find(brandId: string): Promise<Brand | null> {
    const rows = await this.database.query(`SELECT ${brandColumns} FROM brand WHERE id = $1`, [
      brandId,
    ]);
    return rows[0] ? toBrand(rows[0]) : null;
  }

  async sources(query: Input<typeof ListSourcesSchema>): Promise<Page<Source>> {
    const rows = await this.database.query(
      `SELECT ${sourceColumns} FROM brand_source WHERE brand_id = $1 AND strpos(lower(url), lower($2)) > 0
       ORDER BY created_at, id LIMIT $3 OFFSET $4`,
      [query.brandId, query.q, query.limit + 1, query.offset],
    );
    return page(rows.map(toSource), query);
  }

  create(input: Input<typeof CreateBrandSchema>): Promise<Brand> {
    const { requestId, ...fields } = input;
    return this.once(
      { requestId, operation: "brand.create", input: fields, parse: toBrand },
      async (tx) => {
        const rows = await tx.query(
          `INSERT INTO brand (name, note) VALUES ($1, $2) RETURNING ${brandColumns}`,
          [fields.name, fields.note],
        );
        return toBrand(rows[0]);
      },
    );
  }

  update(input: Input<typeof UpdateBrandSchema>): Promise<Brand> {
    const { requestId, brandId, ...fields } = input;
    const key = { requestId, operation: `brand.update:${brandId}`, input: fields, parse: toBrand };
    return this.once(key, async (tx) => {
      const rows = await tx.query(
        `UPDATE brand SET name = $2, note = $3 WHERE id = $1 AND revision = $4 RETURNING ${brandColumns}`,
        [brandId, fields.name, fields.note, fields.revision],
      );
      return rows[0]
        ? toBrand(rows[0])
        : missingOrChanged(tx, "SELECT 1 FROM brand WHERE id = $1", [brandId]);
    });
  }

  createSource(input: Input<typeof CreateSourceSchema>): Promise<Source> {
    const { requestId, brandId, ...fields } = input;
    const key = {
      requestId,
      operation: `source.create:${brandId}`,
      input: fields,
      parse: toSource,
    };
    return this.once(key, async (tx) => {
      const rows = await tx.query(
        `INSERT INTO brand_source (brand_id, channel, region, url) VALUES ($1, $2, $3, $4)
         RETURNING ${sourceColumns}`,
        [brandId, fields.channel, fields.region, fields.url],
      );
      return toSource(rows[0]);
    });
  }

  updateSource(input: Input<typeof UpdateSourceSchema>): Promise<Source> {
    const { requestId, brandId, sourceId, ...fields } = input;
    const key = {
      requestId,
      operation: `source.update:${brandId}:${sourceId}`,
      input: fields,
      parse: toSource,
    };
    return this.once(key, async (tx) => {
      const rows = await tx.query(
        `UPDATE brand_source SET channel = $3, region = $4, url = $5
         WHERE brand_id = $1 AND id = $2 AND revision = $6 RETURNING ${sourceColumns}`,
        [brandId, sourceId, fields.channel, fields.region, fields.url, fields.revision],
      );
      return rows[0] ? toSource(rows[0]) : this.sourceMissing(tx, brandId, sourceId);
    });
  }

  toggleSource(input: Input<typeof ToggleSourceSchema>): Promise<Source> {
    const { requestId, brandId, sourceId, ...fields } = input;
    const key = {
      requestId,
      operation: `source.toggle:${brandId}:${sourceId}`,
      input: fields,
      parse: toSource,
    };
    return this.once(key, async (tx) => {
      const rows = await tx.query(
        `UPDATE brand_source SET enabled = $3 WHERE brand_id = $1 AND id = $2 AND revision = $4
         RETURNING ${sourceColumns}`,
        [brandId, sourceId, fields.enabled, fields.revision],
      );
      return rows[0] ? toSource(rows[0]) : this.sourceMissing(tx, brandId, sourceId);
    });
  }

  private sourceMissing(tx: Queryable, brandId: string, sourceId: string): Promise<never> {
    const sql = "SELECT 1 FROM brand_source WHERE brand_id = $1 AND id = $2";
    return missingOrChanged(tx, sql, [brandId, sourceId]);
  }

  private once<Result>(
    key: Parameters<typeof oncePerRequest<Result>>[1],
    work: (tx: Queryable) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction((tx) => oncePerRequest(tx, key, () => work(tx)))
      .catch(constraintError);
  }
}
