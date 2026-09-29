import type { Queryable } from "@crawl-automation/platform";
import { textRecordCodec } from "@crawl-automation/processing";
import type { TextRecord } from "@crawl-automation/v3-contracts";
import { PostgresResultRegistry } from "./postgres-result-registry.js";

export { PostgresResultRegistry } from "./postgres-result-registry.js";

/** Text results in `processing_result` (the shared result repository with the text record codec). */
export class PostgresTextRegistry extends PostgresResultRegistry<TextRecord> {
  constructor(database: Queryable) {
    super(database, textRecordCodec);
  }
}
