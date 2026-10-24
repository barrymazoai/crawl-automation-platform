import { ReviewEvidence, TextAnswerRecheck } from "@crawl-automation/app";
import { defineErrors, type ObjectStore } from "@crawl-automation/platform";
import { OcrResults, TextEvidence, noResult } from "@crawl-automation/processing";
import { ArtifactResolver, createR2Objects } from "@crawl-automation/platform";
import { swansonLabelCore } from "@crawl-automation/channel-swanson";
import { gncLabelCore } from "@crawl-automation/channels-gnc";
import {
  dtcLabelCore,
  dtcLabelCoreV2,
  dtcLabelCoreV3,
  dtcLabelCoreV4,
} from "@crawl-automation/channel-dtc";
import type { ApiConfig } from "./config.js";

const apiErrors = defineErrors({
  "API.READ_ONLY_STORAGE": {
    category: "RUNTIME",
    message: "The API reads evidence only; it never writes to storage.",
  },
});

const refuseWrite = async (): Promise<never> => {
  throw apiErrors.create("API.READ_ONLY_STORAGE");
};

/** Each channel's label-core readers by policy name; DTC keeps /1–/3 for published documents. */
const labelCores = {
  "swanson-label-core/1": swansonLabelCore,
  "gnc-label-core/1": gncLabelCore,
  "dtc-label-core/1": dtcLabelCore,
  "dtc-label-core/2": dtcLabelCoreV2,
  "dtc-label-core/3": dtcLabelCoreV3,
  "dtc-label-core/4": dtcLabelCoreV4,
};

/**
 * The Review evidence readers: R2 read only, no local copies, no ledger writes. Text sources that came from OCR are
 * checked against R2 alone, as a worker without a ledger does. Each channel supplies its label-core reader.
 */
export function evidenceReaders(storage: NonNullable<ApiConfig["storage"]>) {
  const r2 = createR2Objects(storage.r2, storage.r2Credentials);
  const remote: ObjectStore = {
    read: (key, maxBytes, signal) => r2.store.read(key, maxBytes, signal),
    create: refuseWrite,
  };
  const nothingLocal: ObjectStore = { read: async () => null, create: refuseWrite };
  const noCopies = { read: async () => null, retain: async () => undefined };
  const remoteOcr = new OcrResults({
    local: nothingLocal,
    remote,
    registry: null,
    storageId: storage.storageId,
  });
  const sources = new TextEvidence({
    artifacts: new ArtifactResolver(noCopies, remote),
    ocr: { inspect: async () => noResult },
    remoteOcr,
    labelCores,
  });
  const readers = {
    files: new ReviewEvidence({ objects: remote }),
    recheck: new TextAnswerRecheck({ objects: remote, sources }),
  };
  const recovery = {
    objects: r2.store,
    text: sources,
    storageId: storage.storageId,
    labelCores,
  };
  return { readers, objects: remote, recovery, close: r2.close };
}
