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

/** A cursor is `<collectedAt>|<operationId>` of the last item on the previous page. */
function parseCursor(cursor: string | undefined): [string | null, string | null] {
  const separator = cursor?.indexOf("|") ?? -1;
  if (!cursor || separator < 1) {
    return [null, null];
  }
  return [cursor.slice(0, separator), cursor.slice(separator + 1)];
}

/** `collected_product`, newest first by collection time. */
export class PostgresProductStore implements ProductStore {
  constructor(private readonly database: Database) {}

  async list(query: ProductList): Promise<ProductPage> {
    const [collectedAt, operationId] = parseCursor(query.before);
    const rows = await this.database.query(
      `SELECT operation_id, collected_at, record FROM collected_product
       WHERE ($1::timestamptz IS NULL OR (collected_at, operation_id) < ($1::timestamptz, $2::text))
         AND ($3::text IS NULL OR record->'observation'->>'sourceId' = $3)
         AND ($4::text IS NULL OR record->'observation'->>'listingId' = $4)
       ORDER BY collected_at DESC, operation_id DESC LIMIT $5`,
      [collectedAt, operationId, query.sourceId ?? null, query.listingId ?? null, query.limit + 1],
    );
    const items = rows.slice(0, query.limit).map(toProduct);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last ? `${last.collectedAt}|${last.operationId}` : null;
    return { items, nextCursor };
  }
}
