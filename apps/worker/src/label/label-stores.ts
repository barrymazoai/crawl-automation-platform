import { PostgresResultRegistry } from "@crawl-automation/adapters";
import type { ChannelRegistry } from "@crawl-automation/channels-core";
import {
  LedgerOcrText,
  OcrResults,
  PageEvidence,
  TextEvidence,
  TextResults,
  VisionEvidence,
  VisionRecovery,
  VisionResults,
  ocrRecordCodec,
  textRecordCodec,
  visionRecordCodec,
  type DownloadedFiles,
  type LabelCorePolicies,
} from "@crawl-automation/processing";
import { acquiredImageId, acquisitionKey, FileEvidence } from "@crawl-automation/v3-acquisition";
import { ArtifactResolver } from "@crawl-automation/platform";
import type { OcrRegistration } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "../core-parts.js";
import type { ProcessingSettings } from "./processing-settings.js";

/** The stores and evidence readers every label step shares on this machine. */
export interface LabelStores {
  settings: ProcessingSettings;
  local: CoreParts["local"];
  remote: CoreParts["r2"]["store"];
  reviews: CoreParts["reviewLedger"];
  artifacts: ArtifactResolver;
  pages: PageEvidence;
  downloads: DownloadedFiles & Pick<FileEvidence, "inspect">;
  ocrRegistry: PostgresResultRegistry<OcrRegistration>;
  ocrResults: OcrResults;
  ocrText: LedgerOcrText;
  labelCores: LabelCorePolicies;
  textEvidence: TextEvidence;
  textResults: TextResults;
  visionResults: VisionResults;
  visionRecovery: VisionRecovery;
}

/** Each channel's label-core reader, by its policy name, as the channels supply them. */
export function labelCorePolicies(registry: ChannelRegistry): LabelCorePolicies {
  const policies: Record<string, LabelCorePolicies[string]> = {};
  for (const channel of registry.channels()) {
    const planning = registry.get(channel).planning;
    if (planning?.corePolicy && planning.labelCore) {
      policies[planning.corePolicy] = planning.labelCore;
    }
  }
  return policies;
}

type Base = Pick<LabelStores, "local" | "remote" | "artifacts"> & {
  database: CoreParts["database"];
  storageId: string;
};

/** OCR results in the shared ledger, and the verified OCR text keyword screening and vision read. */
function ocrStores(base: Base) {
  const { database, local, remote, artifacts, storageId } = base;
  const ocrRegistry = new PostgresResultRegistry(database, ocrRecordCodec);
  const ocrResults = new OcrResults({ local, remote, registry: ocrRegistry, storageId });
  return {
    ocrRegistry,
    ocrResults,
    ocrText: new LedgerOcrText({ artifacts, results: ocrResults, registry: ocrRegistry }),
  };
}

/** Vision results in the shared ledger, checked against the OCR text their selection was made from. */
function visionStores(base: Base, ocrText: LedgerOcrText) {
  const { database, local, remote, storageId } = base;
  const verifyOcr = async (
    task: { input: { selection: Parameters<LedgerOcrText["verifiedText"]>[0] } },
    signal: AbortSignal,
  ) => {
    await ocrText.verifiedText(task.input.selection, signal);
  };
  const evidence = new VisionEvidence({ local, remote, verifyOcr });
  const registry = new PostgresResultRegistry(database, visionRecordCodec);
  const deps = { local, remote, registry, evidence, storageId };
  const visionResults = new VisionResults(deps);
  return {
    visionResults,
    visionRecovery: new VisionRecovery(visionResults, { ...deps, settleRemote: true }),
  };
}

export function labelStores(parts: CoreParts, settings: ProcessingSettings): LabelStores {
  const { database, local, r2, copies, reviewLedger: reviews, registry } = parts;
  const remote = r2.store;
  const { storageId } = settings;
  const artifacts = new ArtifactResolver(copies, remote);
  const base: Base = { database, local, remote, artifacts, storageId };
  const ocr = ocrStores(base);
  const labelCores = labelCorePolicies(registry);
  const textEvidence = new TextEvidence({ artifacts, ocr: ocr.ocrResults, labelCores });
  const textRegistry = new PostgresResultRegistry(database, textRecordCodec);
  const textResults = new TextResults({
    local,
    remote,
    registry: textRegistry,
    evidence: textEvidence,
    storageId,
  });
  // The download step's own records and identity rules, read through the port image preparation expects.
  const files = new FileEvidence({ local, remote, copies, reviews });
  const downloads = Object.assign(files, { evidenceKey: acquisitionKey, imageId: acquiredImageId });
  const pages = new PageEvidence({ local, remote, reviews });
  const vision = visionStores(base, ocr.ocrText);
  return {
    settings,
    local,
    remote,
    reviews,
    artifacts,
    pages,
    downloads,
    ...ocr,
    labelCores,
    textEvidence,
    textResults,
    ...vision,
  };
}
