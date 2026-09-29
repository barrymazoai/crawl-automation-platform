import { describe, expect, it } from "vitest";
import type { OcrRegistration } from "@crawl-automation/v3-contracts";
import { OcrResults } from "../ocr/ocr-results.js";
import { MemoryRegistry } from "../testing/memory-ledgers.js";
import { defined } from "../testing/defined.js";
import { MemoryStore } from "../testing/memory-store.js";
import { STORAGE_ID, ocrSetup, resigned, signal } from "../testing/ocr-fixture.js";

// Cloud mode: a ledger-less worker keeps its result in R2; the Mini registers it from the R2 files alone.
function mini(remote: MemoryStore) {
  const registry = new MemoryRegistry<OcrRegistration>();
  const local = new MemoryStore();
  return {
    registry,
    local,
    results: new OcrResults({ local, remote, registry, storageId: STORAGE_ID }),
  };
}

describe("result recovery", () => {
  it("a worker without a ledger keeps and uploads, but never registers", async () => {
    const fixture = ocrSetup(null);
    await fixture.results.capture(fixture.input, fixture.output, signal());
    expect(await fixture.results.uploadMissing(fixture.input, signal())).toMatchObject({
      artifactDurable: true,
      resultRegistered: false,
    });
    await expect(fixture.results.register(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.REGISTRY_UNAVAILABLE",
    });
    await expect(fixture.results.registerFromRemote(fixture.input, signal())).rejects.toMatchObject(
      {
        code: "RESULT.REGISTRY_UNAVAILABLE",
      },
    );
    expect(fixture.remote.writes).toBe(2);
  });

  it("the Mini rebuilds the identical record from R2, registers it once, and repeats harmlessly", async () => {
    const fixture = ocrSetup(null);
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const uploaded = await fixture.results.uploadMissing(fixture.input, signal());
    const ledgerSide = mini(fixture.remote);
    const writes = fixture.remote.writes;
    const facts = await ledgerSide.results.registerFromRemote(fixture.input, signal());
    expect(facts).toMatchObject({
      computedLocal: true,
      artifactDurable: true,
      resultRegistered: true,
    });
    expect(facts.record).toEqual(uploaded.record);
    expect(await ledgerSide.results.registerFromRemote(fixture.input, signal())).toMatchObject({
      resultRegistered: true,
    });
    expect(ledgerSide.registry.writes).toBe(1);
    expect(fixture.remote.writes).toBe(writes);
  });

  it("missing, tampered or foreign R2 files never register", async () => {
    const fixture = ocrSetup(null);
    const ledgerSide = mini(fixture.remote);
    await expect(
      ledgerSide.results.registerFromRemote(fixture.input, signal()),
    ).rejects.toMatchObject({
      code: "RESULT.INCOMPLETE",
    });
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const uploaded = await fixture.results.uploadMissing(fixture.input, signal());
    const key = defined(uploaded.record).result.objectKey;
    const original = defined(fixture.remote.data.get(key));
    const tampered = { ...JSON.parse(Buffer.from(original).toString()), text: "tampered" };
    fixture.remote.data.set(key, Buffer.from(JSON.stringify(tampered)));
    await expect(
      ledgerSide.results.registerFromRemote(fixture.input, signal()),
    ).rejects.toMatchObject({
      code: "RESULT.INTEGRITY",
    });
    fixture.remote.data.set(key, original);
    const foreign = resigned(fixture.input, {
      operationId: `op-foreign-${fixture.input.operationId}`,
    });
    await expect(
      mini(fixture.remote).results.registerFromRemote(foreign, signal()),
    ).rejects.toMatchObject({
      code: "RESULT.INCOMPLETE",
    });
    expect(ledgerSide.registry.writes).toBe(0);
    expect(await ledgerSide.results.registerFromRemote(fixture.input, signal())).toMatchObject({
      resultRegistered: true,
    });
  });

  it("reads a result from R2 alone for a worker without a ledger", async () => {
    const fixture = ocrSetup(null);
    expect(await fixture.results.inspectRemote(fixture.input, signal())).toMatchObject({
      record: null,
    });
    await fixture.results.capture(fixture.input, fixture.output, signal());
    await fixture.results.uploadMissing(fixture.input, signal());
    const reader = mini(fixture.remote).results;
    expect(await reader.inspectRemote(fixture.input, signal())).toMatchObject({
      computedLocal: false,
      artifactDurable: true,
      resultRegistered: false,
    });
    fixture.remote.data.delete(fixture.input.file.objectKey);
    await expect(reader.inspectRemote(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.NOT_DURABLE",
    });
  });
});
