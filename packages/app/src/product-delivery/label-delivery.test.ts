import type {
  ProductLabelIngestAnswer,
  ProductLabelReadAnswer,
} from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { deliverLabel, revisedLabel } from "./label-delivery.js";
import type { ProductObservationWriter } from "./ports.js";
import type { DeliveryLabel, MappedDelivery } from "./wire.js";

const signal = () => new AbortController().signal;

function label(overrides: Partial<DeliveryLabel> = {}): DeliveryLabel {
  return {
    schemaVersion: 1,
    submitter: { namespace: "crawler-v3", operationId: `label-${"a".repeat(64)}` },
    observation: {
      observationId: "wholefoods-label-1",
      capturedAt: "2026-10-12T08:11:00.000Z",
    } as DeliveryLabel["observation"],
    company: { domain: "example.com", expectedCompanyId: "company-1" },
    channel: "wholefoods",
    source: "crawler-v3:product-delivery",
    listing: {} as DeliveryLabel["listing"],
    images: [],
    label: { content: {} as DeliveryLabel["label"]["content"], evidence: {}, confidence: 100 },
    ...overrides,
  };
}

/** Supply Smart as the crawler sees it: an operation keeps the body it completed with. */
function supplySmart(completed: Map<string, string> = new Map()) {
  const sent: DeliveryLabel[] = [];
  const writer = {
    label: async (input: DeliveryLabel) => {
      sent.push(input);
      const id = input.submitter.operationId;
      const body = JSON.stringify(input);
      const known = completed.get(id);
      if (known !== undefined && known !== body) {
        return {
          outcome: "conflict",
          operationId: id,
          error: { code: "idempotency_conflict", message: "Different body for the same operation" },
        } as unknown as ProductLabelIngestAnswer;
      }
      completed.set(id, body);
      return {
        outcome: known === undefined ? "created" : "replayed",
        operationId: id,
        requestFingerprint: `fp-${id}`,
        labelObservationId: `obs-${id}`,
        labelHash: `hash-${id}`,
        steps: { labelObservation: "done" },
        error: null,
      } as unknown as ProductLabelIngestAnswer;
    },
    readLabel: async (input: { operationId: string }) => {
      const stored = JSON.parse(completed.get(input.operationId) ?? "null") as DeliveryLabel;
      return {
        found: true,
        request: { state: "completed" },
        observation: {
          id: `obs-${input.operationId}`,
          operationId: input.operationId,
          submitterNamespace: stored.submitter.namespace,
          externalObservationId: stored.observation.observationId,
        },
        matches: { labelHash: true, requestFingerprint: true },
        problems: [],
      } as unknown as ProductLabelReadAnswer;
    },
  } as unknown as ProductObservationWriter;
  return { writer, sent, completed };
}

const delivery = (body: DeliveryLabel): MappedDelivery => ({
  item: {} as MappedDelivery["item"],
  label: body,
});

describe("label delivery", () => {
  it("sends an unchanged label under its own operation only", async () => {
    const smart = supplySmart();
    expect(await deliverLabel({ writer: smart.writer, product: delivery(label()) }, signal())).toBe(
      null,
    );
    expect(await deliverLabel({ writer: smart.writer, product: delivery(label()) }, signal())).toBe(
      null,
    );
    expect(smart.sent.map((sent) => sent.submitter.operationId)).toEqual([
      label().submitter.operationId,
      label().submitter.operationId,
    ]);
  });

  it("sends a changed label once more as a revision named by its content (2026-11-13)", async () => {
    const smart = supplySmart();
    await deliverLabel({ writer: smart.writer, product: delivery(label()) }, signal());
    const changed = label({ company: { domain: "example.com", expectedCompanyId: "company-2" } });

    expect(await deliverLabel({ writer: smart.writer, product: delivery(changed) }, signal())).toBe(
      null,
    );
    const revision = revisedLabel(changed);
    expect(smart.sent.map((sent) => sent.submitter.operationId)).toEqual([
      label().submitter.operationId,
      label().submitter.operationId,
      revision.submitter.operationId,
    ]);
    expect(revision.submitter.operationId).toMatch(/^label-[0-9a-f]{64}$/);
    expect(revision.observation.observationId).toMatch(/^wholefoods-label-1-r[0-9a-f]{16}$/);
    // The same changed content again is the same revision (replayed); another change is another revision.
    expect(await deliverLabel({ writer: smart.writer, product: delivery(changed) }, signal())).toBe(
      null,
    );
    expect(smart.sent.at(-1)?.submitter.operationId).toBe(revision.submitter.operationId);
    const again = label({ company: { domain: "example.com", expectedCompanyId: "company-3" } });
    expect(revisedLabel(again).submitter.operationId).not.toBe(revision.submitter.operationId);
  });

  it("reports both refusals when the revision is refused too", async () => {
    const changed = label({ source: "other" });
    const revision = revisedLabel(changed);
    const smart = supplySmart(
      new Map([
        [label().submitter.operationId, JSON.stringify(label())],
        [revision.submitter.operationId, "{}"],
      ]),
    );

    const reason = await deliverLabel(
      { writer: smart.writer, product: delivery(changed) },
      signal(),
    );

    expect(reason).toBe(
      "idempotency_conflict: Different body for the same operation; " +
        `revision ${revision.submitter.operationId}: idempotency_conflict: Different body for the same operation`,
    );
    expect(smart.sent).toHaveLength(2);
  });
});
