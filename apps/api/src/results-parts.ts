import { PostgresHistoryReader, PostgresProductStore } from "@crawl-automation/adapters";
import { HistoryService, ProductService } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";

/** Collected products, read only. */
export function productService(parts: { database: Database }): ProductService {
  return new ProductService({ products: new PostgresProductStore(parts.database) });
}

/** A listing's metrics and formula history, read only. */
export function historyService(parts: { database: Database }): HistoryService {
  return new HistoryService({ history: new PostgresHistoryReader(parts.database) });
}
