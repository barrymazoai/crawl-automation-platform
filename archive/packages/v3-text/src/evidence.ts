// Moved to @crawl-automation/processing (text/evidence). The old workers keep the old constructor; the label-core
// policies they relied on are supplied here, where channels may still be named (processing never names one).
import type { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import type { OcrResultHandoff } from "@crawl-automation/v3-results";
import { extractGncLabelCore, extractSwansonLabelCore } from "@crawl-automation/v3-acquisition";
import { TextEvidence as ProcessingTextEvidence, type LabelCorePolicies } from "@crawl-automation/processing";

export const legacyLabelCorePolicies: LabelCorePolicies = {
  "swanson-label-core/1": {
    sourceModule: "channel.product-input",
    sourceVersion: "channel-plan/1",
    extract: extractSwansonLabelCore,
  },
  "gnc-label-core/1": { sourceModule: "gnc.product-input", extract: extractGncLabelCore },
};

export class TextEvidence extends ProcessingTextEvidence {
  constructor(
    artifacts: Pick<ArtifactResolver, "resolve">,
    ocr: Pick<OcrResultHandoff, "inspect">,
    remoteOcr?: Pick<OcrResultHandoff, "inspectRemote">,
  ) {
    super({ artifacts, ocr, ...(remoteOcr ? { remoteOcr } : {}), labelCores: legacyLabelCorePolicies });
  }
}
