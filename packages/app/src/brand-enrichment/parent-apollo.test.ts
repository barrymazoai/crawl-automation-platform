import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BrandWriteService } from "./write-service.js";
import { BrandOwnershipWriteService } from "./ownership-write-service.js";
import { ownershipFixture } from "./testing/ownership-fixture.js";
import { signal } from "./testing/fakes.js";

const apollo = {
  organization: { id: "parent-org", primary_domain: "parent.test" },
  match: { by: "name_address", attempts: 2, note: "Parent legal name and street address" },
  people: [{ id: "person", organization_id: "parent-org" }, { id: "unlabelled" }],
} as const;

async function fixture(status: "matched" | "parent_only" = "parent_only") {
  const test = await ownershipFixture();
  const parentId = randomUUID();
  test.companies.resolve.mockResolvedValue({
    status: "matched",
    companyId: parentId,
    matchedBy: "domain",
    matches: [],
    reason: "domain",
  });
  test.steps.set(`${test.runId}/apollo`, { status, attempts: 2, note: "judged", apollo });
  return {
    ...test,
    parentId,
    write: new BrandWriteService(test),
    ownership: new BrandOwnershipWriteService(test),
  };
}

it("links an existing parent without a child, then enriches it with parent-only Apollo and people", async () => {
  const test = await fixture();
  await test.write.write(test.runId, signal);
  expect(test.companies.enrich.mock.calls[0]?.[0]).not.toHaveProperty("apollo");
  expect(await test.service.review(test.runId, signal)).toEqual({});
  expect(await test.runs.list({ parentRunId: test.runId, limit: 100 })).toEqual([]);
  expect(test.companies.create).not.toHaveBeenCalled();
  await test.ownership.write(test.runId, signal);
  expect(test.companies.enrich).toHaveBeenCalledTimes(2);
  expect(test.companies.enrich).toHaveBeenLastCalledWith(
    { companyId: test.parentId, apollo },
    signal,
  );
  expect(test.companies.link.mock.invocationCallOrder[0]).toBeLessThan(
    test.companies.enrich.mock.invocationCallOrder[1] ?? 0,
  );
  expect(test.companies.unlink).not.toHaveBeenCalled();
  expect(await test.runs.get(test.runId)).toMatchObject({ companyId: test.companyId });
  expect(await test.runs.step(test.runId, "parent-apollo-write")).toMatchObject({
    companyId: test.parentId,
  });
});

it("imports nothing when the parent already holds the organization", async () => {
  const test = await fixture();
  test.companies.get.mockResolvedValue({
    id: test.parentId,
    name: "Parent",
    website: "https://parent.test",
    apolloOrganizationId: apollo.organization.id,
  });
  await test.write.write(test.runId, signal);
  await test.service.review(test.runId, signal);
  await test.ownership.write(test.runId, signal);
  expect(test.companies.enrich).toHaveBeenCalledOnce();
  expect(test.companies.enrich.mock.calls[0]?.[0]).toMatchObject({ companyId: test.companyId });
  expect(test.companies.enrich.mock.calls[0]?.[0]).not.toHaveProperty("apollo");
  expect(await test.runs.step(test.runId, "parent-apollo-write")).toEqual({
    companyId: test.parentId,
    status: "already_held",
  });
});

it("keeps the brand's own matched organization and people on the brand, including after linking", async () => {
  const test = await fixture("matched");
  await test.write.write(test.runId, signal);
  await test.service.review(test.runId, signal);
  await test.ownership.write(test.runId, signal);
  expect(test.companies.enrich).toHaveBeenCalledOnce();
  expect(test.companies.enrich.mock.calls[0]?.[0]).toMatchObject({
    companyId: test.companyId,
    apollo,
  });
  expect(await test.runs.step(test.runId, "parent-apollo-write")).toBeNull();
});

it("also imports parent-only Apollo for a new sub-brand already linked by the family step", async () => {
  const test = await fixture();
  test.steps.set(`${test.runId}/ownership-status`, {
    latestCheck: null,
    owners: [{ toCompanyId: test.parentId, name: "Parent", kind: "brand_of" }],
  });
  expect(await test.service.review(test.runId, signal)).toEqual({});
  await test.ownership.write(test.runId, signal);
  expect(test.companies.link).not.toHaveBeenCalled();
  expect(test.reviewer.review).not.toHaveBeenCalled();
  expect(test.companies.enrich).toHaveBeenCalledExactlyOnceWith(
    { companyId: test.parentId, apollo },
    signal,
  );
});

it("does not migrate to a proposed parent when the link conflicts", async () => {
  const test = await fixture();
  await test.service.review(test.runId, signal);
  test.companies.link.mockResolvedValue({ status: "conflict", detail: "existing owner" });
  await test.ownership.write(test.runId, signal);
  expect(test.companies.enrich).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "ownership-conflict")).toBeTruthy();
});

it("writes parent-only Apollo to a newly created owner once its link is written", async () => {
  const test = await fixture();
  test.companies.resolve.mockResolvedValue({
    status: "unmatched",
    companyId: null,
    matchedBy: null,
    matches: [],
    reason: "missing",
  });
  const plan = await test.service.review(test.runId, signal);
  expect(plan.ownerRunId).toBeDefined();
  const children = await test.runs.list({ parentRunId: test.runId, limit: 100 });
  const owner = children[0];
  expect(owner).toMatchObject({ role: "owner" });
  expect(test.companies.enrich).not.toHaveBeenCalled();
  await test.ownership.write(test.runId, signal);
  expect(test.companies.enrich).toHaveBeenCalledExactlyOnceWith(
    { companyId: owner?.companyId, apollo },
    signal,
  );
});

it("keeps parent-only material local when the reviewer cannot establish an owner", async () => {
  const test = await fixture();
  test.reviewer.review.mockResolvedValue({
    verdict: "cannot_tell",
    reason: "Insufficient ownership evidence",
  });
  await test.service.review(test.runId, signal);
  await test.ownership.write(test.runId, signal);
  expect(test.companies.enrich).not.toHaveBeenCalled();
  expect(test.companies.link).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "apollo")).toMatchObject({
    status: "parent_only",
    apollo,
  });
});
