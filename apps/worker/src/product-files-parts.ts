import { DtcAgentFileTransport } from "@crawl-automation/channel-dtc";
import { FileEvidence, ProductFiles } from "@crawl-automation/channels-core";
import type { CoreParts } from "./core-parts.js";

export function filesService(parts: CoreParts): ProductFiles {
  const { registry, channelPlans, local, r2, copies, reviewLedger, fileTransport } = parts;
  const files = new FileEvidence({ local, remote: r2.store, copies, reviews: reviewLedger });
  return new ProductFiles({
    registry,
    plans: channelPlans,
    files,
    transport: fileTransport,
    transportFor: (request) =>
      request.channel === "dtc" && request.sourcePlan.parserVersion === "dtc-agent/1"
        ? new DtcAgentFileTransport(parts.publication, {
            operationId: request.sourcePlan.source.producer.operationId,
            url: request.sourcePlan.expectedUrl,
            egressId: fileTransport.egressId,
          })
        : fileTransport,
  });
}
