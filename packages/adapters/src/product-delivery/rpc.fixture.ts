import {
  canonicalHash,
  type DeliveryItem,
  type DeliveryLabel,
  type ProductObservationWriter,
} from "@crawl-automation/app";
import type { SupplySmartCall, SupplySmartRpc } from "../supply-smart/supply-smart-rpc.js";
import { z } from "zod";
import { verifiedItem } from "./verification.fixture.js";

type Ingest = Parameters<ProductObservationWriter["ingest"]>[0];
type Verify = Parameters<ProductObservationWriter["verify"]>[0];
export class DeliveryRpcFake implements Pick<SupplySmartRpc, "call"> {
  calls: { path: string; input: unknown }[] = [];
  items = new Map<string, DeliveryItem>();
  labels = new Map<string, DeliveryLabel>();
  refused = new Set<string>();
  labelFailure = false;
  readMismatch = false;
  verifyProblems: string[] = [];
  verifyMissing = false;
  itemProblem: string | null = null;

  async call<Schema extends z.ZodType>(
    call: SupplySmartCall<Schema>,
    signal: AbortSignal,
  ): Promise<z.infer<Schema>> {
    signal.throwIfAborted();
    this.calls.push({ path: call.path, input: structuredClone(call.input) });
    const answer = this.answer(call.path, call.input);
    return call.answer.parse({ ...answer, futureServerField: true });
  }

  private answer(path: string, raw: unknown): object {
    if (path === "product.ingestObservationBatch") {
      return this.ingest(raw as Ingest);
    }
    if (path === "product.ingestLabelObservation") {
      return this.label(raw as DeliveryLabel);
    }
    if (path === "product.getLabelObservation") {
      return this.readLabel(raw as LabelRead);
    }
    if (path === "product.verifyObservationBatch") {
      return this.verify(raw as Verify);
    }
    return {
      ...(raw as object),
      found: true,
      replayed: false,
      scope: "full",
      status: "completed",
      deactivated: 0,
      deactivatedListingIds: [],
      problems: [],
    };
  }

  private ingest(input: Ingest) {
    for (const item of input.items) {
      this.items.set(item.clientRef, item);
    }
    return {
      runId: input.run.runId,
      crawlRunId: "internal-run",
      counts: {
        received: input.items.length,
        ok: input.items.length,
        failed: 0,
        created: 0,
        matched: 0,
        needsReview: 0,
      },
      results: input.items.map((item) => ({
        clientRef: item.clientRef,
        status: this.refused.has(item.externalId) ? "failed" : "ok",
        productId: item.externalId,
        listingId: item.externalId,
        companyId: "company",
        matchedBy: "external_id",
        identity: null,
        observation: { listingId: item.externalId },
        observationSkipped: null,
        facts: null,
        images: [],
        error: this.refused.has(item.externalId)
          ? { code: "company_not_found", message: "Brand not registered" }
          : null,
      })),
    };
  }

  private label(input: DeliveryLabel) {
    const replayed = this.labels.has(input.submitter.operationId);
    this.labels.set(input.submitter.operationId, input);
    return {
      outcome: this.labelFailure ? "conflict" : replayed ? "replayed" : "created",
      operationId: input.submitter.operationId,
      ingestRequestId: "request",
      requestFingerprint: serverHash(input),
      labelObservationId: input.observation.observationId,
      labelHash: serverHash(input.label.content),
      productId: input.listing.externalId,
      listingId: input.listing.externalId,
      companyId: "company",
      company: null,
      matchedBy: "external_id",
      identity: null,
      normalization: null,
      images: [],
      steps: {
        request: "claimed",
        company: "matched",
        product: "done",
        labelObservation: "done",
        formula: "none",
      },
      error: this.labelFailure
        ? { code: "idempotency_conflict", message: "Different body for the same operation" }
        : null,
    };
  }

  private readLabel(input: LabelRead) {
    const label = this.labels.get(input.operationId);
    if (!label) {
      return { found: false };
    }
    return {
      found: true,
      request: {
        id: "request",
        state: "completed",
        fingerprint: serverHash(label),
        startedAt: "2026-10-09T01:00:00Z",
        finishedAt: "2026-10-09T02:00:00Z",
        attempts: 1,
        error: null,
      },
      observation: {
        id: label.observation.observationId,
        submitterNamespace: label.submitter.namespace,
        externalObservationId: label.observation.observationId,
        operationId: input.operationId,
        productId: label.listing.externalId,
        listingId: label.listing.externalId,
        label: label.label.content,
        labelHash: serverHash(label.label.content),
        requestFingerprint: serverHash(label),
      },
      // Like Supply Smart: compare the caller's expected values with the server's own hashes.
      matches: {
        labelHash:
          !this.readMismatch && input.expect?.labelHash === serverHash(label.label.content),
        requestFingerprint:
          !this.readMismatch && input.expect?.requestFingerprint === serverHash(label),
      },
      problems: [],
    };
  }

  private verify(input: Verify) {
    return {
      runId: input.runId,
      found: true,
      run: null,
      verified: input.clientRefs.length - Number(this.verifyMissing),
      expected: input.clientRefs.length,
      readbackHash: "hash",
      problems: this.verifyProblems,
      items: input.clientRefs.map((clientRef) =>
        verifiedItem(clientRef, this.items.get(clientRef)?.externalId === this.itemProblem),
      ),
    };
  }
}

type LabelRead = {
  operationId: string;
  expect?: { labelHash?: string; requestFingerprint?: string };
};

/** Supply Smart hashes its parsed request its own way; the crawler must never assume it equals its own canonical hash. */
function serverHash(value: unknown): string {
  return `server-${canonicalHash(value)}`;
}
