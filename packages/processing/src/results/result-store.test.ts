import { describe, expect, it } from "vitest";
import { sha256 } from "@crawl-automation/v3-artifacts";
import type { OcrRegistration } from "@crawl-automation/v3-contracts";
import { OcrResults } from "../ocr/ocr-results.js";
import { ocrKeys, ocrResultKind } from "../ocr/ocr-kind.js";
import { MemoryRegistry } from "../testing/memory-ledgers.js";
import { defined } from "../testing/defined.js";
import { MemoryStore } from "../testing/memory-store.js";
import { STORAGE_ID, ocrSetup, resigned, signal } from "../testing/ocr-fixture.js";
import { decodeJson, encodeJson, prepareRecord } from "./result-record.js";

// The shared result store, run with the OCR kind (cases carried over from the former OCR result handoff).
describe("result store", () => {
  it("rejects an oversized image reference before any R2 read", async () => {
    const fixture = ocrSetup();
    const input = resigned(fixture.input, {
      file: { ...fixture.input.file, byteSize: 33 * 1024 * 1024 },
    });
    const output = { ...fixture.output, inputFingerprint: input.inputFingerprint };
    await expect(fixture.results.capture(input, output, signal())).rejects.toMatchObject({
      code: "RESULT.INTEGRITY",
    });
    expect(fixture.local.data.has(ocrKeys.journal(input))).toBe(false);
    expect(fixture.remote.reads).toBe(0);
  });

  it("never reports a snapshot when cancelled during the ledger read", async () => {
    const controller = new AbortController();
    const registry = {
      read: async () => (controller.abort(), null),
      register: async () => Promise.reject(new Error("no writes")),
    };
    const fixture = ocrSetup(registry);
    await expect(fixture.results.inspect(fixture.input, controller.signal)).rejects.toThrow();
    expect(fixture.remote.writes).toBe(0);
  });

  it("the image alone is not a result", async () => {
    const fixture = ocrSetup();
    expect(await fixture.results.inspect(fixture.input, signal())).toMatchObject({
      computedLocal: false,
      artifactDurable: false,
      resultRegistered: false,
      record: null,
    });
    await expect(fixture.results.uploadMissing(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.INCOMPLETE",
    });
    expect(fixture.remote.writes).toBe(0);
  });

  it("computed, durable and registered advance one at a time, each written once", async () => {
    const registry = new MemoryRegistry<OcrRegistration>();
    const fixture = ocrSetup(registry);
    await fixture.results.capture(fixture.input, fixture.output, signal());
    expect(await fixture.results.inspect(fixture.input, signal())).toMatchObject({
      computedLocal: true,
      artifactDurable: false,
      resultRegistered: false,
    });
    await expect(fixture.results.register(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.NOT_DURABLE",
    });
    expect(await fixture.results.uploadMissing(fixture.input, signal())).toMatchObject({
      artifactDurable: true,
    });
    expect(await fixture.results.register(fixture.input, signal())).toMatchObject({
      resultRegistered: true,
    });
    await fixture.results.uploadMissing(fixture.input, signal());
    await fixture.results.register(fixture.input, signal());
    expect(fixture.remote.writes).toBe(2);
    expect(registry.writes).toBe(1);
  });

  it("inspection writes nothing", async () => {
    const registry = new MemoryRegistry<OcrRegistration>();
    const fixture = ocrSetup(registry);
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const localWrites = fixture.local.writes;
    await fixture.results.inspect(fixture.input, signal());
    await fixture.results.inspect(fixture.input, signal());
    expect([fixture.local.writes, fixture.remote.writes, registry.writes]).toEqual([
      localWrites,
      0,
      0,
    ]);
  });

  it("a registration whose acknowledgement was lost is settled by reading it back", async () => {
    const registry = new MemoryRegistry<OcrRegistration>();
    const fixture = ocrSetup(registry);
    await fixture.results.capture(fixture.input, fixture.output, signal());
    await fixture.results.uploadMissing(fixture.input, signal());
    registry.loseAcknowledgement = true;
    expect(await fixture.results.register(fixture.input, signal())).toMatchObject({
      resultRegistered: true,
    });
    await fixture.results.register(fixture.input, signal());
    expect(registry.writes).toBe(1);
  });

  it("a ledger failure before the write is unknown, and a later explicit register writes once", async () => {
    const registry = new MemoryRegistry<OcrRegistration>();
    const fixture = ocrSetup(registry);
    await fixture.results.capture(fixture.input, fixture.output, signal());
    await fixture.results.uploadMissing(fixture.input, signal());
    registry.unavailable = true;
    await expect(fixture.results.register(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.REGISTRATION_UNKNOWN",
    });
    expect(await fixture.results.inspect(fixture.input, signal())).toMatchObject({
      resultRegistered: false,
    });
    registry.unavailable = false;
    expect(await fixture.results.register(fixture.input, signal())).toMatchObject({
      resultRegistered: true,
    });
    expect(registry.writes).toBe(2);
    expect(fixture.remote.writes).toBe(2);
  });

  it("an upload whose acknowledgement was lost is read back, not sent again", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    fixture.remote.loseAcknowledgements = true;
    expect(await fixture.results.uploadMissing(fixture.input, signal())).toMatchObject({
      artifactDurable: true,
    });
    expect(fixture.remote.writes).toBe(2);
  });

  it("a journal without both local files cannot authorize an upload", async () => {
    const fixture = ocrSetup();
    const prepared = prepareRecord(ocrResultKind, { ...fixture, storageId: STORAGE_ID });
    await fixture.local.create(prepared.record.result.objectKey, prepared.bytes);
    await fixture.local.create(ocrKeys.journal(fixture.input), encodeJson(prepared.record));
    expect(await fixture.results.inspect(fixture.input, signal())).toMatchObject({
      computedLocal: false,
    });
    await expect(fixture.results.uploadMissing(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.INCOMPLETE",
    });
    expect(fixture.remote.writes).toBe(0);
  });

  it.each(["implementationVersion", "policyVersion", "configFingerprint"] as const)(
    "a changed %s is another task, even with a recomputed fingerprint",
    async (field) => {
      const fixture = ocrSetup();
      await fixture.results.capture(fixture.input, fixture.output, signal());
      const value = field === "configFingerprint" ? "b".repeat(64) : "changed/2";
      const changed = resigned(fixture.input, { [field]: value });
      await expect(fixture.results.inspect(changed, signal())).rejects.toMatchObject({
        code: "RESULT.CONFLICT",
      });
    },
  );

  it("a different result for the same operation never replaces the kept one", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const journal = fixture.local.data.get(ocrKeys.journal(fixture.input));
    const other = {
      ...fixture.output,
      text: "different",
      rawResponse: { text: "different", lines: [] },
    };
    await expect(fixture.results.capture(fixture.input, other, signal())).rejects.toMatchObject({
      code: "RESULT.CONFLICT",
    });
    expect(fixture.local.data.get(ocrKeys.journal(fixture.input))).toEqual(journal);
  });

  it("a completion manifest naming the wrong result hash is an integrity failure", async () => {
    const fixture = ocrSetup();
    const prepared = prepareRecord(ocrResultKind, { ...fixture, storageId: STORAGE_ID });
    const manifest = decodeJson(prepared.manifest) as object;
    const bad = encodeJson({ ...manifest, resultSha256: "0".repeat(64) });
    const completion = { ...prepared.record.completion, sha256: sha256(bad), byteSize: bad.length };
    const record = { ...prepared.record, completion };
    await fixture.local.create(ocrKeys.journal(fixture.input), encodeJson(record));
    fixture.remote.data.set(record.result.objectKey, prepared.bytes);
    fixture.remote.data.set(record.completion.objectKey, bad);
    await expect(fixture.results.inspect(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.INTEGRITY",
    });
  });

  it("a truncated journal is damage, not absence", async () => {
    const fixture = ocrSetup();
    await fixture.local.create(ocrKeys.journal(fixture.input), Buffer.from("{partial"));
    await expect(fixture.results.inspect(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.INTEGRITY",
    });
    expect(fixture.remote.writes).toBe(0);
  });

  it("a registered result missing from R2 is not a usable result", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const facts = await fixture.results.uploadMissing(fixture.input, signal());
    await fixture.results.register(fixture.input, signal());
    fixture.remote.data.delete(defined(facts.record).result.objectKey);
    await expect(fixture.results.inspect(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.NOT_DURABLE",
    });
  });

  it("the ledger and R2 alone still show a registered result without any local copy", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    await fixture.results.uploadMissing(fixture.input, signal());
    await fixture.results.register(fixture.input, signal());
    const fresh = new OcrResults({ ...fixture, local: new MemoryStore(), storageId: STORAGE_ID });
    expect(await fresh.inspect(fixture.input, signal())).toMatchObject({
      computedLocal: false,
      artifactDurable: true,
      resultRegistered: true,
    });
  });

  it("an unreachable R2 is unknown, never absence or permission to upload", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    fixture.remote.unavailable = true;
    await expect(fixture.results.uploadMissing(fixture.input, signal())).rejects.toThrow();
    expect(fixture.remote.writes).toBe(0);
  });

  it("an interrupted upload resumes with only the missing file", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const create = fixture.remote.create.bind(fixture.remote);
    fixture.remote.create = async (key, bytes) => {
      const created = await create(key, bytes);
      fixture.remote.unavailable = true;
      return created;
    };
    await expect(fixture.results.uploadMissing(fixture.input, signal())).rejects.toThrow();
    fixture.remote.create = create;
    fixture.remote.unavailable = false;
    expect(await fixture.results.inspect(fixture.input, signal())).toMatchObject({
      artifactDurable: false,
    });
    expect(await fixture.results.uploadMissing(fixture.input, signal())).toMatchObject({
      artifactDurable: true,
    });
    expect(fixture.remote.writes).toBe(2);
  });

  it("an output for another operation is never kept", async () => {
    const fixture = ocrSetup();
    const foreign = { ...fixture.output, operationId: "another-operation" };
    await expect(fixture.results.capture(fixture.input, foreign, signal())).rejects.toMatchObject({
      code: "RESULT.INTEGRITY",
    });
    expect(fixture.local.writes + fixture.remote.writes).toBe(0);
  });

  it("a result is never silently moved to another storage", async () => {
    const fixture = ocrSetup();
    await fixture.results.capture(fixture.input, fixture.output, signal());
    const elsewhere = new OcrResults({ ...fixture, storageId: "different-r2/1" });
    await expect(elsewhere.inspect(fixture.input, signal())).rejects.toMatchObject({
      code: "RESULT.CONFLICT",
    });
  });
});
