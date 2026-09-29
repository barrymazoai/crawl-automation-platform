import { describe, expect, it } from "vitest";
import { TextStep } from "../step/text-step.js";
import { signal, textFixture } from "../testing/text-fixture.js";
import { TextResultRecovery } from "./text-result-recovery.js";
import { TextResults } from "./text-results.js";

/** A cloud worker: same stores, no ledger, uploads only. */
function cloudRun(given: ReturnType<typeof textFixture>) {
  const deps = {
    local: given.local,
    remote: given.remote,
    registry: null,
    evidence: given.evidence,
    storageId: "fixture/1",
  };
  const results = new TextResults(deps);
  const step = new TextStep({
    model: given.model,
    results,
    reviews: given.reviews,
    nodeId: "cloud",
    mode: "upload-only",
  });
  return step.run(given.input, signal());
}

describe("TextResultRecovery", () => {
  it("registers a cloud worker's result from the bytes it left in R2, without calling the model", async () => {
    const given = textFixture();
    const uploaded = await cloudRun(given);

    const facts = await given.recovery.registerFromRemote(given.input, signal());

    expect(uploaded.status).toBe("uploaded");
    expect(facts.resultRegistered).toBe(true);
    expect(given.model.calls).toBe(1);
  });

  it("refuses remote bytes that were changed after upload", async () => {
    const given = textFixture();
    const uploaded = await cloudRun(given);
    if (uploaded.status !== "uploaded") {
      throw new Error("fixture must upload");
    }
    const key = uploaded.result.objectKey;
    const original = JSON.parse(Buffer.from(given.remote.data.get(key) ?? []).toString());
    given.remote.data.set(key, Buffer.from(JSON.stringify({ ...original, rawResponse: "{}" })));
    const fresh = textFixture();
    const deps = {
      local: fresh.local,
      remote: given.remote,
      registry: fresh.registry,
      evidence: given.evidence,
      storageId: "fixture/1",
    };
    const recovery = new TextResultRecovery(new TextResults(deps), deps);

    await expect(recovery.registerFromRemote(given.input, signal())).rejects.toMatchObject({
      code: "TEXT.RESULT_INTEGRITY",
    });
    expect(fresh.registry.data.size).toBe(0);
  });

  it("a worker without a ledger cannot register", async () => {
    const given = textFixture();
    const deps = {
      local: given.local,
      remote: given.remote,
      registry: null,
      evidence: given.evidence,
      storageId: "fixture/1",
    };
    const recovery = new TextResultRecovery(new TextResults(deps), deps);

    await expect(recovery.registerFromRemote(given.input, signal())).rejects.toMatchObject({
      code: "TEXT.REGISTRY_UNAVAILABLE",
    });
  });
});
