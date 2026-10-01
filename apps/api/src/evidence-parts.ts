import {
  createEvidenceService,
  createReviewRecovery,
  PostgresHtmlCaptureReader,
  PostgresReviewStore,
} from "@crawl-automation/adapters";
import {
  OriginalEvidenceService,
  ReviewService,
  type EvidenceService,
} from "@crawl-automation/app";
import { configuredDtcSites } from "@crawl-automation/channel-dtc";
import { ScraperApiPages } from "@crawl-automation/channels-core";
import type { Database } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";
import type { evidenceReaders } from "./evidence-readers.js";
import { channelRegistry } from "./resources/channel-registry.js";

interface ReadParts {
  database: Database;
  storageReaders: ReturnType<typeof evidenceReaders> | null;
}

/** Test evidence uses the same channel options as product capture, with one paid-request enforcement. */
export function evidenceService({ config }: { config: ApiConfig }): EvidenceService {
  return createEvidenceService({
    ...config.evidence,
    storage: config.storage,
    channels: channelRegistry(configuredDtcSites(config.browser?.dtc)),
    createPages: (client, settings) => new ScraperApiPages(client, settings),
  });
}

/** Reads captures and Reviews through the same read-only R2 connection. */
export function originalEvidenceService(parts: ReadParts): OriginalEvidenceService {
  return new OriginalEvidenceService({
    captures: new PostgresHtmlCaptureReader(parts.database),
    objects: parts.storageReaders?.objects,
  });
}

export function reviewService(parts: ReadParts): ReviewService {
  const reviews = new PostgresReviewStore(parts.database);
  const evidence = parts.storageReaders?.readers;
  const recovery =
    parts.storageReaders && createReviewRecovery(parts.database, parts.storageReaders.recovery);
  return new ReviewService(evidence && recovery ? { reviews, evidence, recovery } : { reviews });
}
