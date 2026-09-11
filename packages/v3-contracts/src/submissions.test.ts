import { describe, expect, it } from "vitest";
import { CollectionSubmission, SubmitCollection } from "./submissions.js";

const id = "e5b786f7-c661-4e44-bfbc-3438a7db97b9";
const valid = {
  requestId: id, workflowId: `v3-collection-${id}`, state: "PENDING_DELIVERY",
  snapshot: { brandId: id, brandName: "Sample", sourceId: id, sourceRevision: 2,
    channel: "dtc", region: "US", url: "https://sample.example/products" },
  createdAt: "2026-09-05T00:00:00.000Z",
};
describe("shared collection submission contracts", () => {
  it("accepts one explicit source revision without implicit defaults", () => {
    expect(SubmitCollection.parse({ sourceRevision: 2 })).toEqual({ sourceRevision: 2 });
    for (const input of [{}, { sourceRevision: 0 }, { sourceRevision: "2" }, [{ sourceRevision: 2 }]])
      expect(SubmitCollection.safeParse(input).success).toBe(false);
  });
  it("does not let callers choose workflows, queues, network or arbitrary source URLs", () => {
    for (const field of ["workflowId", "taskQueue", "worker", "url", "force", "network", "companyId"])
      expect(SubmitCollection.safeParse({ sourceRevision: 2, [field]: "injected" }).success).toBe(false);
  });
  it("represents a pending handoff, never pretends it is running", () => {
    expect(CollectionSubmission.parse(valid)).toEqual(valid);
    expect(CollectionSubmission.safeParse({ ...valid, state: "RUNNING" }).success).toBe(false);
  });
  it("ties workflow identity to the stable request ID", () => {
    expect(CollectionSubmission.safeParse({ ...valid, workflowId: `v3-collection-${"a".repeat(36)}` }).success).toBe(false);
  });
  it("requires a complete versioned snapshot and serializable timestamp", () => {
    const { sourceRevision: _, ...snapshot } = valid.snapshot;
    expect(CollectionSubmission.safeParse({ ...valid, snapshot }).success).toBe(false);
    expect(CollectionSubmission.safeParse({ ...valid, createdAt: new Date() }).success).toBe(false);
  });
});
