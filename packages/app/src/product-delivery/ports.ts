import type {
  ChannelProductEvidence,
  LabelCollectedProduct,
  SharedEnrichmentRecord,
  ProductIngestBatchAnswer,
  ProductVerifyBatchAnswer,
  ProductCompleteRunAnswer,
  ProductLabelIngestAnswer,
  ProductLabelReadAnswer,
} from "@crawl-automation/v3-contracts";
import type { ProductDelivery, ProductDeliveryRequest } from "../brand-enrichment/task-ports.js";
import type { DeliveryItem, DeliveryLabel, DeliveryRun } from "./wire.js";

export interface DeliveryHistory {
  capturedAt: string;
  listing: { channel: string; externalId: string; url: string };
  owner: { runId: string; sourceId: string };
  capture: { variantId: string | null };
  metrics: Record<string, unknown>;
  evidence: { objectKey: string; sha256: string }[];
}
export interface DeliveryProduct {
  operationId?: string;
  queueId: string;
  batchId: string;
  sourceId: string;
  externalId: string;
  collection: LabelCollectedProduct | null;
  history: DeliveryHistory | null;
  product: ChannelProductEvidence | null;
  enrichment: SharedEnrichmentRecord | null;
  problem?: string;
}
export interface ProductDeliveryScan {
  siteKey: string | null;
  siteScope: "single-brand" | "multi-brand" | "unknown";
  sourceId: string;
  scanId: string;
  startedAt: string | null;
  state: string;
  full: boolean;
  capped: boolean;
  unresolvedFamilies: number;
  products: number;
  queued: number;
  recent: number;
}
export interface DeliverySnapshot {
  products: DeliveryProduct[];
  review: number;
  pending: number;
  scans: ProductDeliveryScan[];
}
export interface ProductDeliveryReader extends Pick<ProductDelivery, "catalogs"> {
  read(request: ProductDeliveryRequest, signal: AbortSignal): Promise<DeliverySnapshot>;
}
export interface ProductDeliveryHold {
  kind: "review" | "pending";
  operationId: string;
  listingId: string;
  variantId: string | null;
}
export interface ProductObservationWriter {
  ingest(
    input: { run: DeliveryRun; items: DeliveryItem[] },
    signal: AbortSignal,
  ): Promise<ProductIngestBatchAnswer>;
  label(input: DeliveryLabel, signal: AbortSignal): Promise<ProductLabelIngestAnswer>;
  readLabel(
    input: {
      submitterNamespace: string;
      operationId: string;
      expect: { labelHash: string; requestFingerprint: string };
    },
    signal: AbortSignal,
  ): Promise<ProductLabelReadAnswer>;
  verify(
    input: { runId: string; clientRefs: string[]; expect: Record<string, unknown>[] },
    signal: AbortSignal,
  ): Promise<ProductVerifyBatchAnswer>;
  complete(
    input: { runId: string; status: "completed" },
    signal: AbortSignal,
  ): Promise<ProductCompleteRunAnswer>;
}
