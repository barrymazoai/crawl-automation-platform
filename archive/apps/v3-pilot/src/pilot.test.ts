import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkerContainer,
  withOperation,
  type WorkerContainer,
} from "./bootstrap/container.js";
import { loadConfig } from "./bootstrap/config.js";
import { MockOcr } from "./adapters/mock-ocr.js";
import { LocalEvidence } from "./adapters/local-evidence.js";
import { validateInput, fingerprint, sha256 } from "./contracts/fingerprint.js";
import { CONFIG, SUPPORTED } from "./contracts/index.js";
import { ArtifactRefSchema as SharedArtifact, OcrInputSchema as SharedOcr, CompletionSchema as SharedCompletion } from "@crawl-automation/v3-contracts";
import { ArtifactRefSchema, OcrInputSchema, CompletionSchema } from "./contracts/index.js";
import { makeFixture } from "./runners/fixture.js";
import { createActivities } from "./runners/activities.js";

const containers: WorkerContainer[] = [];
afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.dispose()));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "crawler-v3-p0-unit-"));
  const ocr = new MockOcr(),
    container = createWorkerContainer(root, () => ocr);
  containers.push(container);
  return {
    root,
    ocr,
    container,
    activities: createActivities(container, () => new AbortController().signal),
    input: makeFixture("test"),
  };
}

describe("P0 contracts and recovery", () => {
  it("uses shared schema instances and the declared public config fingerprint", () => {
    expect(ArtifactRefSchema).toBe(SharedArtifact); expect(OcrInputSchema).toBe(SharedOcr); expect(CompletionSchema).toBe(SharedCompletion);
    expect(sha256(CONFIG)).toBe(SUPPORTED.configFingerprint);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // Frozen wire-protocol vector: changes require an explicit fingerprint version.
    expect(makeFixture("vector").inputFingerprint).toBe("70367005d384a860c31c159424f9aaba1f22c459e1460fba255709e82bfc9a23");
  });
  it("rejects incompatible public config before submitting OCR", async () => {
    const { activities,input,ocr }=await setup();
    const changed={...input,configFingerprint:"b".repeat(64)}; changed.inputFingerprint=fingerprint(changed);
    await expect(activities.ocrFile(changed)).rejects.toThrow("RUNTIME.INCOMPATIBLE_CONSUMER");
    expect(ocr.submissions).toBe(0);
  });
  it("does not accept a complete proof with tampered policy/config versions", async () => {
    const { activities,input,root,ocr }=await setup(); const completion=await activities.ocrFile(input);
    for (const field of ["implementationVersion","policyVersion","configFingerprint","requestId"] as const) {
      await writeFile(join(root,`completions/${input.operationId}.json`), JSON.stringify({...completion,[field]:field==="configFingerprint"?"b".repeat(64):"other"}));
      expect(await activities.verifyOcr(input)).toEqual({status:"unverified",code:"INPUT.CONFLICT"});
      await expect(activities.ocrFile(input)).rejects.toThrow();
    }
    expect(ocr.submissions).toBe(1);
  });
  it("accepts one file, rejects batches, extra fields and cross-product evidence", () => {
    const input = makeFixture("contract");
    expect(validateInput(input)).toEqual(input);
    expect(() => validateInput({ ...input, file: [input.file] })).toThrow();
    expect(() => validateInput({ ...input, files: [input.file] })).toThrow();
    expect(() =>
      validateInput({
        ...input,
        file: { ...input.file, observationId: "another" },
      }),
    ).toThrow();
    expect(() =>
      validateInput({ ...input, implementationVersion: "unknown" }),
    ).toThrow();
  });
  it("fingerprints content and policy, not storage location", () => {
    const input = makeFixture("fingerprint");
    expect(
      fingerprint({
        ...input,
        file: { ...input.file, objectKey: "sources/moved.png" },
      }),
    ).toBe(input.inputFingerprint);
    expect(() =>
      validateInput({
        ...input,
        file: { ...input.file, sha256: "b".repeat(64) },
      }),
    ).toThrow();
  });
  it("repeated delivery performs OCR once and reopens proof after restart", async () => {
    const { activities, input, ocr, root } = await setup();
    const first = await activities.ocrFile(input);
    expect(await activities.ocrFile(input)).toEqual(first);
    expect(ocr.submissions).toBe(1);
    const reopened = new LocalEvidence(root);
    expect(await reopened.verify(input)).toEqual({
      status: "verified",
      completion: first,
    });
    expect((await reopened.read(input, first)).provider).toBe(
      "mock-no-network",
    );
  });
  it("concurrent duplicate delivery cannot submit OCR twice", async () => {
    const { activities, input, ocr } = await setup();
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => activities.ocrFile(input)),
    );
    expect(settled.some((r) => r.status === "fulfilled")).toBe(true);
    expect(ocr.submissions).toBe(1);
  });
  it("a started operation without completion remains unknown, never recomputed", async () => {
    const { activities, input, ocr, container } = await setup();
    await container.resolve("evidence").reserve(input);
    await expect(activities.ocrFile(input)).rejects.toThrow(
      "no matching complete proof",
    );
    expect(ocr.submissions).toBe(0);
  });
  it("does not reuse an operation with a different input fingerprint", async () => {
    const { activities, input, ocr } = await setup();
    await activities.ocrFile(input);
    const changed = { ...input, brandId: "changed-brand" };
    changed.inputFingerprint = fingerprint(changed);
    expect(await activities.verifyOcr(changed)).toMatchObject({
      status: "unverified",
      code: "INPUT.CONFLICT",
    });
    await expect(activities.ocrFile(changed)).rejects.toThrow();
    expect(ocr.submissions).toBe(1);
  });
  it("corrupted output fails proof verification and does not trigger OCR", async () => {
    const { activities, input, ocr, root } = await setup();
    const completion = await activities.ocrFile(input);
    await writeFile(join(root, completion.resultKey), "partial-test-output");
    expect(await activities.verifyOcr(input)).toMatchObject({
      status: "unverified",
      code: "EVIDENCE.INCOMPLETE",
    });
    await expect(activities.ocrFile(input)).rejects.toThrow();
    expect(ocr.submissions).toBe(1);
  });
  it("a new observation of the same content is a new operation", async () => {
    const { activities, input, ocr } = await setup();
    await activities.ocrFile(input);
    await activities.ocrFile(makeFixture("new-observation"));
    expect(ocr.submissions).toBe(2);
  });
  it("isolates concurrent operation contexts and disposes the owned client", async () => {
    const { container, ocr } = await setup();
    const contexts = await Promise.all(
      ["one", "two"].map((operationId) =>
        withOperation(
          container,
          { operationId, signal: new AbortController().signal },
          async (ports) => {
            await Promise.resolve();
            return ports.context.operationId;
          },
        ),
      ),
    );
    expect(contexts).toEqual(["one", "two"]);
    expect(() => container.resolve("context")).toThrow();
    await container.dispose();
    expect(ocr.closed).toBe(true);
  });
  it("records passive Review idempotently without changing the evidence", async () => {
    const { activities, input, root } = await setup();
    const record = {
      schemaVersion: 1 as const,
      requestId: input.requestId,
      category: "ARTIFACT" as const,
      blockedBy: null,
      operationId: input.operationId,
      observationId: input.observationId,
      inputFingerprint: input.inputFingerprint,
      code: "EVIDENCE.INCOMPLETE" as const,
      stage: "ocr" as const,
      executionFact: "unknown" as const,
      evidenceKey: `completions/${input.operationId}.json`,
      automaticRetry: false as const,
    };
    const key = await activities.recordReview(record);
    expect(await activities.recordReview(record)).toBe(key);
    expect(JSON.parse(await readFile(join(root, key), "utf8"))).toEqual(record);
  });
  it("fails startup on unsupported roles, remote servers or invalid capacity", () => {
    expect(loadConfig({}).concurrency).toBe(1);
    expect(() => loadConfig({ V3_ROLE: "all-in-one" })).toThrow();
    expect(() =>
      loadConfig({ V3_TEMPORAL_ADDRESS: "production.example:7233" }),
    ).toThrow();
    expect(() => loadConfig({ V3_CONCURRENCY: "0" })).toThrow();
  });
});
