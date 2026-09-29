import type { Queryable } from "@crawl-automation/platform";
import { recordHash, type RecordCodec, type ResultRegistry } from "@crawl-automation/processing";

interface ResultRow {
  record: unknown;
  record_hash: string;
}

interface OwnedRecord {
  input: { operationId: string };
}

/** Processing results in `processing_result`, for every kind: written once, read back with their hash. */
export class PostgresResultRegistry<
  TRecord extends OwnedRecord,
> implements ResultRegistry<TRecord> {
  constructor(
    private readonly database: Queryable,
    private readonly codec: RecordCodec<TRecord>,
  ) {}

  async read(operationId: string): Promise<TRecord | null> {
    const rows = await this.database.query<ResultRow>(
      "SELECT record, record_hash FROM public.processing_result WHERE operation_id = $1",
      [operationId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const record = this.codec.parseRecord(row.record);
    if (
      record.input.operationId !== operationId ||
      recordHash(this.codec, record) !== row.record_hash
    ) {
      throw this.codec.fail("integrity");
    }
    return record;
  }

  async register(raw: TRecord): Promise<void> {
    const record = this.codec.parseRecord(raw);
    const hash = recordHash(this.codec, record);
    await this.database.query(
      `INSERT INTO public.processing_result (operation_id, record_hash, record)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (operation_id) DO NOTHING`,
      [record.input.operationId, hash, JSON.stringify(record)],
    );
    const saved = await this.read(record.input.operationId);
    if (!saved || recordHash(this.codec, saved) !== hash) {
      throw this.codec.fail("conflict");
    }
  }
}
