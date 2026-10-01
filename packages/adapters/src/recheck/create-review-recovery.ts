import { ReviewRecoveryService } from "@crawl-automation/app";
import { ArtifactResolver, type Database, type ObjectStore } from "@crawl-automation/platform";
import {
  LedgerOcrText,
  OcrResults,
  SavedLabelRecheck,
  ocrRecordCodec,
  textRecordCodec,
  visionRecordCodec,
  recheckErrors,
  type LabelCorePolicies,
  type TextSource,
} from "@crawl-automation/processing";
import { PostgresReviewStore } from "../postgres/postgres-review-store.js";
import { PostgresResultRegistry } from "../postgres/postgres-result-registry.js";
import { PostgresRecoveryLedger } from "./postgres-recovery-ledger.js";

interface RecoveryParts {
  objects: ObjectStore;
  storageId: string;
  text: TextSource;
  labelCores: LabelCorePolicies;
}

/** Only reads, deterministic processing and explicit publication are wired here. No provider client exists. */
export function createReviewRecovery(database: Database, parts: RecoveryParts) {
  const refuseWrite = async (): Promise<never> => {
    throw recheckErrors.create("RECHECK.PUBLICATION_UNVERIFIED");
  };
  const remote = { read: parts.objects.read.bind(parts.objects), create: refuseWrite };
  const local = { read: async () => null, create: refuseWrite };
  const copies = { read: async () => null, retain: async () => undefined };
  const artifacts = new ArtifactResolver(copies, remote);
  const registry = new PostgresResultRegistry(database, ocrRecordCodec);
  const results = new OcrResults({ local, remote, registry, storageId: parts.storageId });
  const ocr = new LedgerOcrText({ artifacts, results, registry });
  const reviews = new PostgresReviewStore(database);
  const recheck = new SavedLabelRecheck({
    ...parts,
    objects: remote,
    reviews,
    textRecords: new PostgresResultRegistry(database, textRecordCodec),
    imageRecords: new PostgresResultRegistry(database, visionRecordCodec),
    verifyOcr: async (task, signal) => {
      await ocr.verifiedText(task.input.selection, signal);
    },
  });
  return new ReviewRecoveryService({
    reviews,
    recheck,
    objects: parts.objects,
    ledger: new PostgresRecoveryLedger(database),
  });
}
