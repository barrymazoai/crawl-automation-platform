import { expect, it, vi } from "vitest";
import type { ApolloJudge } from "./task-ports.js";
import type { Apollo } from "./ports.js";
import { BrandApolloService } from "./apollo-service.js";
import { seededRuns } from "./testing/memory-runs.js";
import { signal } from "./testing/fakes.js";

async function fixture() {
  const store = await seededRuns();
  const apollo = {
    searchOrganizations: vi.fn<Apollo["searchOrganizations"]>(async () => [
      { id: "found", primary_domain: "example.test" },
    ]),
    people: vi.fn<Apollo["people"]>(async () => [
      { id: "good", organization_id: "found" },
      { id: "wrong", organization_id: "parent" },
      // Apollo's free people search omits organization_id (2026-10-09); scoped to "found", so kept.
      { id: "unlabelled" },
    ]),
  };
  const judge = { next: vi.fn<ApolloJudge["next"]>() };
  const service = new BrandApolloService({ runs: store.runs, apollo, judge, searchLimit: 3 });
  return { ...store, apollo, judge, service };
}
it("stops a judge that repeatedly asks for searches after three attempts", async () => {
  const test = await fixture();
  test.judge.next.mockResolvedValue({
    action: "search",
    query: { by: "domain", domain: "example.test" },
  });
  expect(await test.service.match(test.runId, signal)).toMatchObject({
    status: "no_match",
    attempts: 3,
  });
  expect(test.apollo.searchOrganizations).toHaveBeenCalledTimes(3);
  expect(test.apollo.people).not.toHaveBeenCalled();
  expect(test.judge.next.mock.lastCall?.[0].searchesLeft).toBe(0);
});
it.each(["invented", "found"])(
  "refuses fabricated IDs or unverifiable domain ties (%s)",
  async (id) => {
    const test = await fixture();
    test.apollo.searchOrganizations.mockResolvedValue([
      { id: "found", primary_domain: "other.test" },
    ]);
    test.judge.next
      .mockResolvedValueOnce({ action: "search", query: { by: "name", name: "Example" } })
      .mockResolvedValueOnce({
        action: "accept",
        organizationId: id,
        tie: "domain",
        note: "looks right",
      });
    expect(await test.service.match(test.runId, signal)).toMatchObject({ status: "no_match" });
    expect(test.apollo.people).not.toHaveBeenCalled();
  },
);
it("keeps parent matches as local clues and never fetches the parent's contacts", async () => {
  const test = await fixture();
  test.judge.next
    .mockResolvedValueOnce({ action: "search", query: { by: "domain", domain: "example.test" } })
    .mockResolvedValueOnce({
      action: "parent_only",
      organizationId: "found",
      note: "Parent organization",
    });
  expect(await test.service.match(test.runId, signal)).toMatchObject({ status: "parent_only" });
  expect(await test.runs.clues(test.runId)).toMatchObject([{ signal: "apollo_parent" }]);
  expect(test.apollo.people).not.toHaveBeenCalled();
});
it("accepts a verified domain and drops people belonging to another organization", async () => {
  const test = await fixture();
  test.judge.next
    .mockResolvedValueOnce({ action: "search", query: { by: "domain", domain: "example.test" } })
    .mockResolvedValueOnce({
      action: "accept",
      organizationId: "found",
      tie: "domain",
      note: "Same domain",
    });
  const result = await test.service.match(test.runId, signal);
  expect(result.status).toBe("matched");
  expect(result.apollo?.people).toEqual([
    { id: "good", organization_id: "found" },
    { id: "unlabelled" },
  ]);
  expect(test.apollo.people).toHaveBeenCalledWith("found", signal);
});
