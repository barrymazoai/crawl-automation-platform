import type { AmazonQueueHistory, QueueItemsQuery } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { amazonMigrationPreview, queueItems, queueStatus } from "./queue-queries.js";

/** Read-only legacy Amazon history. New work always uses PostgresChannelQueueStore. */
export class PostgresQueueStore implements AmazonQueueHistory {
  constructor(private readonly database: Queryable) {}

  status() {
    return queueStatus(this.database);
  }

  items(query: QueueItemsQuery) {
    return queueItems(this.database, query);
  }

  migrationPreview() {
    return amazonMigrationPreview(this.database);
  }
}
