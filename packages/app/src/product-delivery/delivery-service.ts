import { errorCodeOf } from "@crawl-automation/platform";
import type {
  ProductDelivery,
  ProductDeliveryRequest,
  ProductDeliveryResult,
} from "../brand-enrichment/task-ports.js";
import type { ProductDeliveryReader, ProductObservationWriter, DeliveryProduct } from "./ports.js";
import { mapDeliveryProduct } from "./mapping.js";
import { deliveryRun } from "./run-mapping.js";
import type { MappedDelivery, DeliveryRun } from "./wire.js";
import { acceptedItems, verificationProblems, verificationExpectation } from "./verification.js";
import { deliverLabel } from "./label-delivery.js";
import { productDeliveryErrors } from "./errors.js";

/**
 * Items per ingestObservationBatch call. KAN-259 (2026-11-07): 144 TrioMedica items in one call exceeded Supply Smart's
 * fixed 60 s RPC timeout (as GNC sync batches of 200 did on 10-15); the run was ingested but its labels never sent.
 */
const DELIVERY_BATCH = 50;

export class ProductDeliveryService implements ProductDelivery {
  constructor(
    private readonly deps: { reader: ProductDeliveryReader; writer: ProductObservationWriter },
  ) {}

  catalogs(...args: Parameters<ProductDelivery["catalogs"]>) {
    return this.deps.reader.catalogs(...args);
  }

  async deliver(
    request: ProductDeliveryRequest,
    signal: AbortSignal,
  ): Promise<ProductDeliveryResult> {
    signal.throwIfAborted();
    const snapshot = await this.deps.reader.read(request, signal);
    const result: ProductDeliveryResult = {
      captured: snapshot.products.length,
      review: snapshot.review,
      delivered: 0,
      refused: [],
    };
    const mapped = this.mapProducts(snapshot.products, request, result);
    if (mapped.length === 0) {
      return result;
    }
    const run = deliveryRun({ request, snapshot, mapped });
    for (let offset = 0; offset < mapped.length; offset += DELIVERY_BATCH) {
      signal.throwIfAborted();
      await this.deliverBatch(
        { run, products: mapped.slice(offset, offset + DELIVERY_BATCH), result },
        signal,
      );
    }
    if (run.scope === "full" && result.refused.length === 0 && result.delivered === mapped.length) {
      await this.complete(run, signal);
    }
    return result;
  }

  /**
   * KAN-259: the same read and mapping as `deliver`, without any Supply Smart call; `delivered` stays 0 and
   * `deliverable` counts the products `deliver` would send.
   */
  async preview(
    request: ProductDeliveryRequest,
    signal: AbortSignal,
  ): Promise<ProductDeliveryResult & { deliverable: number }> {
    signal.throwIfAborted();
    const snapshot = await this.deps.reader.read(request, signal);
    const result: ProductDeliveryResult = {
      captured: snapshot.products.length,
      review: snapshot.review,
      delivered: 0,
      refused: [],
    };
    const mapped = this.mapProducts(snapshot.products, request, result);
    return { ...result, deliverable: mapped.length };
  }

  private async complete(run: DeliveryRun, signal: AbortSignal) {
    const answer = await this.deps.writer.complete(
      { runId: run.runId, status: "completed" },
      signal,
    );
    if (
      answer.runId !== run.runId ||
      !answer.found ||
      answer.scope !== "full" ||
      answer.status !== "completed" ||
      answer.problems.length
    ) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.COMPLETE_FAILED", {
        details: { answer },
      });
    }
  }

  private mapProducts(
    products: DeliveryProduct[],
    request: ProductDeliveryRequest,
    result: ProductDeliveryResult,
  ) {
    const mapped: MappedDelivery[] = [];
    const seen = new Set<string>();
    products = preferredFirst(products, request.sourceOrder);
    for (const product of products) {
      try {
        const value = mapDeliveryProduct(product, request);
        if (seen.has(value.item.clientRef)) {
          throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
        }
        seen.add(value.item.clientRef);
        mapped.push(value);
      } catch (error) {
        result.refused.push({
          externalId: product.externalId,
          reason: product.problem ?? errorCodeOf(error) ?? "PRODUCT_DELIVERY.MATERIAL_MISSING",
        });
      }
    }
    return mapped;
  }

  private async deliverBatch(
    input: { run: DeliveryRun; products: MappedDelivery[]; result: ProductDeliveryResult },
    signal: AbortSignal,
  ) {
    const { run, products, result } = input;
    const answer = await this.deps.writer.ingest(
      { run, items: products.map((product) => product.item) },
      signal,
    );
    const accepted: MappedDelivery[] = [];
    for (const entry of acceptedItems(answer, { runId: run.runId, products })) {
      const reason =
        entry.reason ??
        (await deliverLabel({ writer: this.deps.writer, product: entry.product }, signal));
      if (reason) {
        result.refused.push({ externalId: entry.product.item.externalId, reason });
      } else {
        accepted.push(entry.product);
      }
    }
    if (accepted.length === 0) {
      return;
    }
    const verified = await this.deps.writer.verify(
      {
        runId: run.runId,
        clientRefs: accepted.map(({ item }) => item.clientRef),
        expect: accepted.map(verificationExpectation),
      },
      signal,
    );
    for (const entry of verificationProblems(verified, { runId: run.runId, products: accepted })) {
      if (entry.reason) {
        result.refused.push({ externalId: entry.product.item.externalId, reason: entry.reason });
      } else {
        result.delivered += 1;
      }
    }
  }
}

/**
 * KAN-253: a product listed by a sub-brand's catalog and by its family's whole-store catalog is delivered once, from
 * the sub-brand's catalog; the stable sort keeps every other order as the reader returned it.
 */
function preferredFirst(products: DeliveryProduct[], order: readonly string[] | undefined) {
  if (!order?.length) {
    return products;
  }
  const rank = (sourceId: string) => {
    const index = order.indexOf(sourceId);
    return index === -1 ? order.length : index;
  };
  return [...products].sort((left, right) => rank(left.sourceId) - rank(right.sourceId));
}
