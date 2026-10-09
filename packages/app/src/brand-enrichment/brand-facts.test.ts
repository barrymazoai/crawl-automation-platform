import { expect, it } from "vitest";
import { brandFacts } from "./brand-facts.js";
import { seededRuns } from "./testing/memory-runs.js";

it("keeps the brand's own primary domain that Supply Smart skipped, and withholds only conflicts", async () => {
  const { runs, runId } = await seededRuns();
  await runs.saveStep({
    runId,
    step: "domain-additions",
    output: {
      added: [],
      existing: [],
      conflicts: [{ domain: "taken.test", ownerCompanyId: "00000000-0000-4000-8000-000000000001" }],
      skipped: [{ domain: "example.test", reason: "primary_domain" }],
    },
    archiveKeys: [],
  });
  const facts = await brandFacts(runs, runId);
  // MANTRA Labs, 2026-10-09: withholding the skipped primary left Apollo with nothing to match.
  expect(facts.domains).toEqual(["example.test"]);
  expect([...facts.domains, ...facts.formerDomains]).not.toContain("taken.test");
});
