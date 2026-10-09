import type { ProductDeliveryRequest } from "../brand-enrichment/task-ports.js";
import type { DeliveryProduct, DeliverySnapshot, ProductDeliveryScan } from "./ports.js";
import type { DeliveryRun, MappedDelivery } from "./wire.js";

export function deliveryRun(input: {
  request: ProductDeliveryRequest;
  snapshot: DeliverySnapshot;
  mapped: MappedDelivery[];
}): DeliveryRun {
  const { request, snapshot, mapped } = input;
  const complete =
    snapshot.review === 0 &&
    snapshot.pending === 0 &&
    mapped.length === snapshot.products.length &&
    allVariantsMapped(mapped) &&
    new Set(request.sourceIds).size === snapshot.scans.length &&
    snapshot.scans.every(
      (scan) =>
        scan.siteKey === request.siteKey &&
        scan.siteScope === "single-brand" &&
        fullScan(scan, snapshot.products),
    );
  const times = complete
    ? snapshot.scans.flatMap((scan) => (scan.startedAt ? [scan.startedAt] : []))
    : mapped.map(({ item }) => item.capturedAt);
  return {
    runId: request.ingestRunId,
    channel: "dtc",
    scope: complete ? "full" : "partial",
    siteKey: request.siteKey,
    companyDomain: request.siteKey,
    startedAt: times.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? "",
    source: `crawl-automation:${request.ingestRunId}`,
  };
}

function allVariantsMapped(mapped: MappedDelivery[]) {
  const anchors = new Set(mapped.map(({ item }) => item.externalId));
  return mapped.every(({ item }) => {
    const variants = item.attrsRaw.websiteVariants;
    return (
      Array.isArray(variants) &&
      variants.every((variant: { variantId: string | null; listingId: string }) =>
        anchors.has(variant.variantId ?? variant.listingId),
      )
    );
  });
}

function fullScan(scan: ProductDeliveryScan, all: DeliveryProduct[]) {
  const products = all.filter((product) => product.sourceId === scan.sourceId);
  const conditions = [
    scan.state === "complete",
    scan.full,
    !scan.capped,
    scan.unresolvedFamilies === 0,
    scan.recent === 0,
    scan.startedAt !== null,
    scan.products === scan.queued,
    scan.queued === new Set(products.map((product) => product.queueId)).size,
  ];
  return (
    conditions.every(Boolean) &&
    products.every(
      (product) =>
        product.batchId === scan.scanId &&
        product.history !== null &&
        Date.parse(product.history.capturedAt) >= Date.parse(scan.startedAt ?? ""),
    )
  );
}
