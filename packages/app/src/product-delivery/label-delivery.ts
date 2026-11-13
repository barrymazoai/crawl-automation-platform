import { canonicalHash } from "../history/canonical.js";
import type { ProductObservationWriter } from "./ports.js";
import type { DeliveryLabel, MappedDelivery } from "./wire.js";
import type { ProductLabelReadAnswer } from "@crawl-automation/v3-contracts";

/** Supply Smart's answer when an operation it completed is sent again with a different body. */
const CONFLICT = "idempotency_conflict";

/**
 * Sends the label and reads it back. A label's operation is named by the formula it carries (formula once), but its
 * body also holds what changes around that formula: enrichment, translation, company, listing. When Supply Smart
 * refuses the same operation with a different body, the label is sent once more as a revision named by its content
 * (owner 2026-11-13: 818 Whole Foods and 4,695 Amazon labels were refused, some since 10-17). Unchanged labels keep
 * their operation, so no product gains a second label merely because this rule exists.
 */
export async function deliverLabel(
  input: { writer: ProductObservationWriter; product: MappedDelivery },
  signal: AbortSignal,
): Promise<string | null> {
  const first = await submit(input.writer, input.product, signal);
  if (first.code !== CONFLICT) {
    return first.reason;
  }
  const label = revisedLabel(input.product.label);
  const revised = await submit(input.writer, { ...input.product, label }, signal);
  return revised.reason === null
    ? null
    : `${first.reason}; revision ${label.submitter.operationId}: ${revised.reason}`;
}

/**
 * The same label as a revision of its operation, named by its content: a resend of the same content is the same
 * revision (Supply Smart replays it), a further change is another one.
 */
export function revisedLabel(label: DeliveryLabel): DeliveryLabel {
  const { submitter, observation, ...rest } = label;
  const { observationId, ...observed } = observation;
  const content = canonicalHash({ ...rest, observation: observed }).slice(0, 16);
  return {
    ...label,
    submitter: {
      ...submitter,
      operationId: `label-${canonicalHash([submitter.operationId, content])}`,
    },
    observation: { ...observation, observationId: `${observationId}-r${content}` },
  };
}

async function submit(
  writer: ProductObservationWriter,
  product: MappedDelivery,
  signal: AbortSignal,
): Promise<{ code: string | null; reason: string | null }> {
  const answer = await writer.label(product.label, signal);
  if (answer.error) {
    return { code: answer.error.code, reason: `${answer.error.code}: ${answer.error.message}` };
  }
  const operationId = product.label.submitter.operationId;
  if (
    !["created", "replayed"].includes(answer.outcome) ||
    answer.operationId !== operationId ||
    answer.steps.labelObservation !== "done" ||
    !answer.labelObservationId ||
    !answer.labelHash
  ) {
    return { code: null, reason: `PRODUCT_DELIVERY.LABEL_VERIFY_FAILED: ${answer.outcome}` };
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
  return { code: null, reason: same ? null : "PRODUCT_DELIVERY.LABEL_VERIFY_FAILED" };
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
