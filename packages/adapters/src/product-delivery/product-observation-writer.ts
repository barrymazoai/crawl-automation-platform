import type { ProductObservationWriter } from "@crawl-automation/app";
import {
  ProductIngestBatchAnswerSchema,
  ProductLabelIngestAnswerSchema,
  ProductLabelReadAnswerSchema,
  ProductVerifyBatchAnswerSchema,
  ProductCompleteRunAnswerSchema,
} from "@crawl-automation/v3-contracts";
import type { SupplySmartRpc } from "../supply-smart/supply-smart-rpc.js";

export class SupplySmartObservationWriter implements ProductObservationWriter {
  constructor(private readonly rpc: Pick<SupplySmartRpc, "call">) {}
  ingest(input: Parameters<ProductObservationWriter["ingest"]>[0], signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "product.ingestObservationBatch",
        input,
        answer: ProductIngestBatchAnswerSchema,
      },
      signal,
    );
  }
  label(input: Parameters<ProductObservationWriter["label"]>[0], signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "product.ingestLabelObservation",
        input,
        answer: ProductLabelIngestAnswerSchema,
      },
      signal,
    );
  }
  readLabel(input: Parameters<ProductObservationWriter["readLabel"]>[0], signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "product.getLabelObservation",
        input,
        answer: ProductLabelReadAnswerSchema,
      },
      signal,
    );
  }
  verify(input: Parameters<ProductObservationWriter["verify"]>[0], signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "product.verifyObservationBatch",
        input,
        answer: ProductVerifyBatchAnswerSchema,
      },
      signal,
    );
  }
  complete(input: Parameters<ProductObservationWriter["complete"]>[0], signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "product.completeCrawlRun",
        input,
        answer: ProductCompleteRunAnswerSchema,
      },
      signal,
    );
  }
}
