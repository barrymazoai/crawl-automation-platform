import { describe, expect, it, vi } from "vitest";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { LabelCollection, labelCollectedHash } from "./label-collection.js";

const signal = () => new AbortController().signal;

/** An observation already collected under one operation, and a newer operation for the same observation. */
async function secondVersionSetup() {
  const setup = assemblySetup();
  setup.join.manifest.evidencePolicy = "label-image-first/4";
  const first = await setup.assembly.run(setup.join, signal());
  expect(
    (await setup.collector.run({ join: setup.join, evidenceKey: first.evidenceKey }, signal()))
      .status,
  ).toBe("collected");
  const old = defined([...setup.collected.values()][0]);
  setup.join.manifest.operationId = "new-quality-version";
  const next = await setup.assembly.run(setup.join, signal());
  return { ...setup, old, input: { join: setup.join, evidenceKey: next.evidenceKey } };
}

// Cases carried over from the former collection-conflict tests.
describe("collection of an already collected observation", () => {
  it("keeps the new candidate in a Review linked to the old record, without an insert or claim", async () => {
    const setup = await secondVersionSetup();
    const append = vi.fn();
    const registry = { ...setup.registry, append, readObservation: vi.fn(async () => setup.old) };
    const collection = new LabelCollection({ ...setup.deps, assembly: setup.assembly, registry });
    const out = await collection.run(setup.input, signal());
    if (out.status !== "review") {
      throw new Error(JSON.stringify(out));
    }
    expect(out.codes).toEqual(["LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED"]);
    const review = defined(setup.records.get(out.reviewId));
    expect(review.rawError.details).toMatchObject({
      versionPolicy: "retain-first/1",
      existingCollection: {
        operationId: setup.old.operationId,
        recordHash: labelCollectedHash(setup.old),
      },
    });
    expect(review.candidate).not.toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(
      setup.remote.data.has("v3/label-products/new-quality-version/collection-intent.json"),
    ).toBe(false);
    expect(await collection.run(setup.input, signal())).toEqual(out);
    expect(setup.collected.size).toBe(1);
  });

  it("a race after the insert is classified by reading the observation back", async () => {
    const setup = await secondVersionSetup();
    const readObservation = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(setup.old);
    const append = vi.fn(async () => undefined);
    const collection = new LabelCollection({
      ...setup.deps,
      assembly: setup.assembly,
      registry: { ...setup.registry, append, readObservation },
    });
    expect(await collection.run(setup.input, signal())).toMatchObject({
      codes: ["LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED"],
    });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("an unconfirmed registration stays unknown rather than posing as a known conflict", async () => {
    const setup = await secondVersionSetup();
    const registry = {
      ...setup.registry,
      append: vi.fn(async () => undefined),
      readObservation: async () => null,
    };
    const collection = new LabelCollection({ ...setup.deps, assembly: setup.assembly, registry });
    expect(await collection.run(setup.input, signal())).toMatchObject({
      codes: ["LABEL_COLLECTION.REGISTRATION_UNKNOWN"],
    });
  });
});
