import type { ProductObservationWriter } from "./ports.js";
import type { MappedDelivery } from "./wire.js";
import type { ProductLabelReadAnswer } from "@crawl-automation/v3-contracts";

export async function deliverLabel(
  input: { writer: ProductObservationWriter; product: MappedDelivery },
  signal: AbortSignal,
): Promise<string | null> {
  const { writer, product } = input;
  const answer = await writer.label(product.label, signal);
  if (answer.error) {
    return `${answer.error.code}: ${answer.error.message}`;
  }
  const operationId = product.label.submitter.operationId;
  if (
    !["created", "replayed"].includes(answer.outcome) ||
    answer.operationId !== operationId ||
    answer.steps.labelObservation !== "done" ||
    !answer.labelObservationId ||
    !answer.labelHash
  ) {
    return `PRODUCT_DELIVERY.LABEL_VERIFY_FAILED: ${answer.outcome}`;
  }
  // Read back against the hashes Supply Smart computed when it accepted this label. Ours differ by design: the history
  // canonical form keeps `undefined` keys and the server hashes the parsed request (Kate Farms, 2026-10-09).
  const read = await writer.readLabel(
    {
      submitterNamespace: product.label.submitter.namespace,
      operationId,
      expect: { labelHash: answer.labelHash, requestFingerprint: answer.requestFingerprint },
    },
    signal,
  );
  const same = read.observation?.id === answer.labelObservationId && matchesLabel(read, product);
  return same ? null : "PRODUCT_DELIVERY.LABEL_VERIFY_FAILED";
}

function matchesLabel(read: ProductLabelReadAnswer, product: MappedDelivery) {
  const record = read.observation;
  if (!record) {
    return false;
  }
  return [
    read.found,
    read.request?.state === "completed",
    read.problems.length === 0,
    read.matches.labelHash === true,
    read.matches.requestFingerprint === true,
    record.operationId === product.label.submitter.operationId,
    record.submitterNamespace === product.label.submitter.namespace,
    record.externalObservationId === product.label.observation.observationId,
  ].every(Boolean);
}
