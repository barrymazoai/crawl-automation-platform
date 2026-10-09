import { expect, it } from "vitest";
import { BrandWriteService } from "./write-service.js";
import { seededRuns } from "./testing/memory-runs.js";
import { companies, family, research, signal } from "./testing/fakes.js";

it.each([null, true, false])(
  "guards previously saved Apollo people at write (sameBrand=%s)",
  async (sameBrand) => {
    const test = await seededRuns();
    const companyPort = companies();
    const apollo = {
      organization: { id: "old-startup" },
      match: { by: "domain", attempts: 1, note: "Original domain matched" },
      people: [{ id: "former-person", organization_id: "old-startup" }],
    };
    test.steps.set(`${test.runId}/family`, {
      ...family,
      redirect:
        sameBrand === null
          ? null
          : { fromDomain: "example.test", toDomain: "owner.test", sameBrand },
    });
    const saved = { status: "matched", attempts: 1, note: "Original domain matched", apollo };
    test.steps.set(`${test.runId}/apollo`, saved);
    test.steps.set(`${test.runId}/research`, research);
    await new BrandWriteService({ runs: test.runs, companies: companyPort }).write(
      test.runId,
      signal,
    );
    expect(companyPort.enrich.mock.lastCall?.[0].apollo).toEqual({
      ...apollo,
      people: sameBrand === false ? [] : apollo.people,
    });
    expect(await test.runs.step(test.runId, "apollo")).toEqual(saved);
    expect(saved.apollo.people).toHaveLength(1);
    expect(await test.runs.step(test.runId, "apollo-people-policy")).toEqual(
      sameBrand === false ? { peopleSkipped: "absorbed_brand" } : null,
    );
  },
);
