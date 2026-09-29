import type {
  CollectedProduct,
  ProductList,
  ProductPage,
  ProductStore,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { z } from "zod";

const Record = z.object({
  observation: z.object({
    sourceId: z.string(),
    listingId: z.string(),
    variantId: z.string().nullable(),
  }),
  formula: z
    .object({
      rows: z.array(z.unknown()).optional(),
      columns: z.array(z.object({ rows: z.array(z.unknown()) })).optional(),
    })
    .nullish(),
  otherIngredients: z.object({ items: z.array(z.unknown()) }).nullish(),
  warnings: z.array(z.object({ code: z.string() })).nullish(),
});

const Row = z.object({ operation_id: z.string(), collected_at: z.date(), record: z.unknown() });

function formulaRows(formula: z.infer<typeof Record>["formula"]): number {
  if (formula?.columns) {
    return formula.columns.reduce((total, column) => total + column.rows.length, 0);
  }
  return formula?.rows?.length ?? 0;
}

function toProduct(raw: unknown): CollectedProduct {
  const row = Row.parse(raw);
  const record = Record.parse(row.record);
  return {
    operationId: row.operation_id,
    ...record.observation,
    collectedAt: row.collected_at.toISOString(),
    formulaRows: formulaRows(record.formula),
    otherIngredients: record.otherIngredients?.items.length ?? 0,
    warningCodes: (record.warnings ?? []).map((warning) => warning.code),
  };
}

/** `collected_product`, newest first, paged by operation ID. */
export class PostgresProductStore implements ProductStore {
  constructor(private readonly database: Database) {}

  async list(query: ProductList): Promise<ProductPage> {
    const rows = await this.database.query(
      `SELECT operation_id, collected_at, record FROM collected_product
       WHERE ($1::text IS NULL OR operation_id < $1)
         AND ($2::text IS NULL OR record->'observation'->>'sourceId' = $2)
         AND ($3::text IS NULL OR record->'observation'->>'listingId' = $3)
       ORDER BY operation_id DESC LIMIT $4`,
      [query.before ?? null, query.sourceId ?? null, query.listingId ?? null, query.limit + 1],
    );
    const items = rows.slice(0, query.limit).map(toProduct);
    const nextCursor = rows.length > query.limit ? (items.at(-1)?.operationId ?? null) : null;
    return { items, nextCursor };
  }
}
