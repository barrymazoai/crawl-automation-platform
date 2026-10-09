import { expect, it } from "vitest";
import { BrandIdentityService } from "./identity-service.js";
import { BrandCloseService } from "./close-service.js";
import { companies, requests, signal } from "./testing/fakes.js";
import { seededRuns } from "./testing/memory-runs.js";
import { requireRun } from "./run-records.js";

async function fixture() {
  const store = await seededRuns();
  const run = await requireRun(store.runs, store.runId);
  store.records.set(run.runId, { ...run, companyId: null });
  const deps = { ...store, companies: companies(), requests: requests() };
  return { ...deps, identity: new BrandIdentityService(deps), close: new BrandCloseService(deps) };
}

it("completes a found request with the existing company id and no company changes", async () => {
  const test = await fixture();
  test.companies.resolveDomain.mockResolvedValue({
    status: "matched",
    companyId: test.companyId,
    companyName: "Example",
    candidates: [],
    reason: "domain",
  });
  expect(await test.identity.resolve(test.runId, signal)).toMatchObject({
    company: { id: test.companyId },
    existing: true,
  });
  expect(test.companies.resolveDomain).toHaveBeenCalledWith("example.test", signal);
  await test.close.close({ runId: test.runId, state: "completed" }, signal);
  expect(test.requests.update).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "completed",
      companyId: test.companyId,
      summary: { existing: true },
    }),
    signal,
  );
  expect(await test.runs.get(test.runId)).toMatchObject({
    state: "completed",
    stage: "closed",
    companyId: test.companyId,
    summary: { existing: true },
  });
  for (const method of [
    "create",
    "addDomains",
    "enrich",
    "link",
    "unlink",
    "recordOwnershipCheck",
  ] as const) {
    expect(test.companies[method]).not.toHaveBeenCalled();
  }
  expect(await test.identity.resolve(test.runId, signal)).toMatchObject({ existing: true });
  expect(test.companies.resolveDomain).toHaveBeenCalledOnce();
});

it("creates an unmatched company and preserves its new status when identity is read again", async () => {
  const test = await fixture();
  const result = await test.identity.resolve(test.runId, signal);
  expect(result.existing).toBe(false);
  expect(test.companies.create).toHaveBeenCalledWith(
    { name: "Example Nutrition", website: "https://example.test", isNutrition: true },
    signal,
  );
  expect(await test.identity.resolve(test.runId, signal)).toEqual(result);
  expect(test.companies.create).toHaveBeenCalledOnce();
});

it.each(["ambiguous", "conflict"] as const)(
  "keeps the %s identity failure path",
  async (status) => {
    const test = await fixture();
    test.companies.resolveDomain.mockResolvedValue({
      status,
      companyId: null,
      companyName: null,
      candidates: [],
      reason: "unresolved",
    });
    await expect(test.identity.resolve(test.runId, signal)).rejects.toMatchObject({
      code: "BRAND_ENRICHMENT.IDENTITY_UNRESOLVED",
    });
    expect(test.companies.create).not.toHaveBeenCalled();
  },
);

it.each(["owner", "sub_brand"] as const)("a precreated %s child is still new", async (role) => {
  const store = await seededRuns(role);
  expect(
    await new BrandIdentityService({ ...store, companies: companies() }).resolve(
      store.runId,
      signal,
    ),
  ).toMatchObject({ company: { id: store.companyId }, existing: false });
});
