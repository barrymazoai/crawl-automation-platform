import type { Queryable } from "@crawl-automation/platform";
import {
  assemblyFailure,
  labelCollectedHash,
  type LabelCollectedRegistry,
} from "@crawl-automation/processing";
import {
  LabelCollectedProductSchema,
  type LabelCollectedProduct,
} from "@crawl-automation/v3-contracts";

interface CollectedRow {
  observation_id: string;
  record_hash: string;
  record: unknown;
}

/** Collected products in `collected_product`: one per operation, written once, read back with their hash. */
export class PostgresCollectedProducts implements LabelCollectedRegistry {
  constructor(private readonly database: Queryable) {}

  async read(operationId: string): Promise<LabelCollectedProduct | null> {
    const rows = await this.database.query<CollectedRow>(
      "SELECT observation_id, record_hash, record FROM public.collected_product WHERE operation_id = $1",
      [operationId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const record = LabelCollectedProductSchema.parse(row.record);
    const intact =
      record.operationId === operationId &&
      record.observation.observationId === row.observation_id &&
      labelCollectedHash(record) === row.record_hash;
    if (!intact) {
      throw assemblyFailure("LABEL_COLLECTION.INTEGRITY");
    }
    return record;
  }

  /** The product collected for an observation, whichever operation collected it. */
  async readObservation(observationId: string): Promise<LabelCollectedProduct | null> {
    const rows = await this.database.query<{ operation_id: string }>(
      "SELECT operation_id FROM public.collected_product WHERE observation_id = $1",
      [observationId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const record = await this.read(String(row.operation_id));
    if (!record || record.observation.observationId !== observationId) {
      throw assemblyFailure("LABEL_COLLECTION.INTEGRITY");
    }
    return record;
  }

  async append(raw: LabelCollectedProduct): Promise<void> {
    const record = LabelCollectedProductSchema.parse(raw);
    const hash = labelCollectedHash(record);
    await this.database.query(
      `INSERT INTO public.collected_product (operation_id, observation_id, record_hash, record)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [record.operationId, record.observation.observationId, hash, JSON.stringify(record)],
    );
    const saved = await this.read(record.operationId);
    if (!saved || labelCollectedHash(saved) !== hash) {
      throw assemblyFailure("LABEL_COLLECTION.CONFLICT");
    }
  }
}
