import type { Queryable } from "@crawl-automation/platform";
import {
  hashRecord,
  textFailure,
  textRecord,
  type TextResultRegistry,
} from "@crawl-automation/processing";
import type { TextRecord } from "@crawl-automation/v3-contracts";

interface ResultRow {
  record: unknown;
  record_hash: string;
}

/** Text results in `processing_result`: written once, read back with their hash. */
export class PostgresTextRegistry implements TextResultRegistry {
  constructor(private readonly database: Queryable) {}

  async read(operationId: string): Promise<TextRecord | null> {
    const rows = await this.database.query<ResultRow>(
      "SELECT record, record_hash FROM public.processing_result WHERE operation_id = $1",
      [operationId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const record = textRecord(row.record);
    if (record.input.operationId !== operationId || hashRecord(record) !== row.record_hash) {
      throw textFailure("TEXT.RESULT_INTEGRITY");
    }
    return record;
  }

  async register(raw: TextRecord): Promise<void> {
    const record = textRecord(raw);
    const hash = hashRecord(record);
    await this.database.query(
      `INSERT INTO public.processing_result (operation_id, record_hash, record)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (operation_id) DO NOTHING`,
      [record.input.operationId, hash, JSON.stringify(record)],
    );
    const saved = await this.read(record.input.operationId);
    if (!saved || hashRecord(saved) !== hash) {
      throw textFailure("TEXT.RESULT_CONFLICT");
    }
  }
}
