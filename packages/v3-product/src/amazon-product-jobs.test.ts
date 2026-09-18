import { expect, it } from "vitest";
import { amazonFixture } from "../../v3-channels/src/amazon-live.fixture.js";
import { AmazonProductJobs } from "./amazon-product-jobs.js";

const signal = () => AbortSignal.timeout(3000);

async function jobs(stopAfter?: "full" | "observation") {
  const f = amazonFixture(), job = await f.job(), d = job.discovery;
  const db = { query: async () => ({ rows: [{ record: d }] }) } as any;
  return { f, job, d, make: (publication = f.publication) => new AmazonProductJobs(db, publication,
    { scope: f.scope, queues: job.queues, resources: job.resources, ...(stopAfter ? { stopAfter } : {}) }) };
}

it("a product first captured by a price-only pass resumes through the full pipeline", async () => {
  const priced = await jobs("observation"), first = await priced.make().prepare(priced.d, priced.d.workflowId, signal());
  expect(first.stopAfter).toBe("observation");
  // Same product, same publication, now under the full policy: the retained record must not block it.
  const full = await jobs();
  const resumed = await full.make(priced.f.publication).prepare(priced.d, priced.d.workflowId, signal());
  expect(resumed.stopAfter).toBeUndefined();
  expect(resumed.operationId).toBe(first.operationId);
});

it("a price-only product already in flight keeps its own stopping point when the policy has moved on", async () => {
  const priced = await jobs("observation"), running = await priced.make().prepare(priced.d, priced.d.workflowId, signal());
  const full = await jobs();
  expect(await full.make(priced.f.publication).verify(running, priced.d.workflowId, signal())).toEqual(running);
});

it("a queue or lane change is not a conflict; a record naming another operation is", async () => {
  const priced = await jobs("observation");
  const first = await priced.make().prepare(priced.d, priced.d.workflowId, signal());
  // Deployment policy moved on — different capture queue, a lane added to the gate — but this is the same product.
  const moved = await jobs();
  const other = new AmazonProductJobs({ query: async () => ({ rows: [{ record: priced.d }] }) } as any, priced.f.publication,
    { scope: moved.f.scope, queues: { ...moved.job.queues, capture: "somewhere-else" }, resources: moved.job.resources });
  const resumed = await other.prepare(priced.d, priced.d.workflowId, signal());
  expect(resumed.queues.capture).toBe("somewhere-else");
  expect(resumed.operationId).toBe(first.operationId);
  // Identity still holds: a job claiming another operation for this discovery is refused.
  await expect(other.verify({ ...resumed, operationId: `amazon-capture-${"0".repeat(64)}` }, priced.d.workflowId, signal()))
    .rejects.toThrow("AMAZON.PRODUCT_POLICY_CONFLICT");
});
