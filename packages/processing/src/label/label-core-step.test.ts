import { describe, expect, it } from "vitest";
import { ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import {
  ArtifactRefSchema,
  ObservationSchema,
  TextInputSchema,
  textFingerprint,
} from "@crawl-automation/v3-contracts";
import { TextEvidence } from "../text/evidence/text-evidence.js";
import { MemoryStore } from "../testing/memory-store.js";
import { decodeJson, hashString } from "../results/result-record.js";
import { defined } from "../testing/defined.js";
import { LabelCoreStep } from "./label-core-step.js";

const PAGE = "<main>Supplement Facts page</main>";
const CORE = "Supplement Facts\nServing Size 1\nAmount Per Serving\nVitamin C 10 mg";
const policies = {
  "gnc-label-core/1": { sourceModule: "gnc.product-input", extract: () => CORE },
  "swanson-label-core/1": {
    sourceModule: "channel.product-input",
    sourceVersion: "channel-plan/1",
    extract: () => CORE,
  },
};
const signal = () => AbortSignal.timeout(5000);

/** A captured page and its full prepared document in R2, from the given producer. */
async function coreSetup(options: { sourceId?: string; module?: string; version?: string } = {}) {
  const sourceId = options.sourceId ?? "d7b322c8-e1e4-43fa-970a-7d1f8ffb8b61";
  const owner = ObservationSchema.parse({
    schemaVersion: 1,
    requestId: "request",
    observationId: "obs",
    brandId: "brand",
    sourceId,
    listingId: "sku",
    variantId: null,
  });
  const bytes = Buffer.from(PAGE);
  const producer = {
    operationId: "source-op",
    module: options.module ?? "gnc.product-input",
    implementationVersion: options.version ?? "1",
  };
  const common = {
    schemaVersion: 1,
    observationId: "obs",
    sourceId,
    listingId: "sku",
    variantId: null,
  };
  const source = ArtifactRefSchema.parse({
    ...common,
    artifactId: "html",
    kind: "source-html",
    mediaType: "text/html",
    objectKey: "test/source.html",
    sha256: sha256(bytes),
    byteSize: bytes.length,
    producer,
  });
  const full = Buffer.from(
    JSON.stringify({
      ...owner,
      producer: "page.prepare",
      pageIndex: null,
      source,
      text: "Full retained page",
    }),
  );
  const pageProducer = {
    operationId: "page-op",
    module: "page.prepare",
    implementationVersion: "1",
  };
  const fullDocument = ArtifactRefSchema.parse({
    ...common,
    artifactId: "full",
    kind: "result-json",
    mediaType: "application/json",
    objectKey: "test/full.json",
    sha256: sha256(full),
    byteSize: full.length,
    producer: pageProducer,
  });
  const remote = new MemoryStore();
  remote.data.set(source.objectKey, bytes);
  remote.data.set(fullDocument.objectKey, full);
  const artifacts = new ArtifactResolver(
    { read: async () => null, retain: async () => undefined },
    remote,
  );
  const step = new LabelCoreStep({ artifacts, remote, policies });
  return { owner, source, artifacts, remote, step, input: { owner, fullDocument } };
}

// Cases carried over from the former GNC and Swanson label-core preparations.
describe("label-core step", () => {
  it("publishes the core document, which the text step's evidence then reads", async () => {
    const setup = await coreSetup();
    const core = await setup.step.run(setup.input, signal());
    expect(await setup.step.inspect(setup.input, signal())).toEqual(core);
    const unsigned = {
      ...setup.owner,
      operationId: "text-core",
      module: "codex.text" as const,
      implementationVersion: "codex-text/3",
      policyVersion: "label-text/2",
      configFingerprint: "a".repeat(64),
      resultSchemaVersion: 3 as const,
      source: { kind: "prepared" as const, document: core.document },
      range: core.range,
    };
    const task = TextInputSchema.parse({
      ...unsigned,
      inputFingerprint: textFingerprint(unsigned, hashString),
    });
    const ocr = { inspect: async () => Promise.reject(new Error("OCR must not run")) };
    const evidence = new TextEvidence({ artifacts: setup.artifacts, ocr, labelCores: policies });
    expect((await evidence.resolve(task, signal())).text).toBe(CORE);
  });

  it("keeps the page's provenance in the stored document", async () => {
    const setup = await coreSetup({ module: "channel.product-input", version: "channel-plan/1" });
    const core = await setup.step.run(setup.input, signal());
    expect(core.document.producer.implementationVersion).toBe("swanson-label-core/1");
    const stored = decodeJson(defined(setup.remote.data.get(core.document.objectKey)));
    expect(stored).toMatchObject({
      source: setup.source,
      text: CORE,
      corePolicy: "swanson-label-core/1",
    });
  });

  it("a page no policy reads is refused before anything is written", async () => {
    const setup = await coreSetup({ module: "other.product-input" });
    const writes = setup.remote.writes;
    await expect(setup.step.run(setup.input, signal())).rejects.toMatchObject({
      code: "LABEL_CORE.SOURCE_UNSUPPORTED",
    });
    expect(setup.remote.writes).toBe(writes);
  });

  it.each([
    ["another source", { sourceId: "another-source" }],
    ["another listing", { listingId: "foreign" }],
  ])("a document owned by %s is refused before anything is written", async (_name, change) => {
    const setup = await coreSetup();
    const writes = setup.remote.writes;
    await expect(
      setup.step.run({ ...setup.input, owner: { ...setup.owner, ...change } }, signal()),
    ).rejects.toThrow();
    expect(setup.remote.writes).toBe(writes);
  });

  it("inspection never prepares; a cold re-read or re-run writes nothing", async () => {
    const setup = await coreSetup();
    const before = setup.remote.writes;
    await expect(setup.step.inspect(setup.input, signal())).rejects.toMatchObject({
      code: "LABEL_CORE.HANDOFF_UNVERIFIED",
    });
    expect(setup.remote.writes).toBe(before);
    const core = await setup.step.run(setup.input, signal());
    const writes = setup.remote.writes;
    expect(core).toMatchObject({ status: "prepared", input: setup.input, range: { start: 0 } });
    expect(await setup.step.inspect(setup.input, signal())).toEqual(core);
    expect(await setup.step.run(setup.input, signal())).toEqual(core);
    expect(setup.remote.writes).toBe(writes);
  });

  it("a cancelled preparation publishes nothing", async () => {
    const setup = await coreSetup();
    const before = setup.remote.writes;
    const controller = new AbortController();
    controller.abort();
    await expect(setup.step.run(setup.input, controller.signal)).rejects.toThrow();
    expect(setup.remote.writes).toBe(before);
  });

  it("a stored document that differs from the derived one is refused", async () => {
    const setup = await coreSetup();
    const core = await setup.step.run(setup.input, signal());
    const stored = decodeJson(defined(setup.remote.data.get(core.document.objectKey))) as object;
    setup.remote.data.set(
      core.document.objectKey,
      Buffer.from(JSON.stringify({ ...stored, text: "changed" })),
    );
    await expect(setup.step.inspect(setup.input, signal())).rejects.toMatchObject({
      code: "LABEL_CORE.HANDOFF_UNVERIFIED",
    });
  });

  it("a reader failure without a code is recorded as such", async () => {
    const setup = await coreSetup();
    const failing = {
      "gnc-label-core/1": {
        sourceModule: "gnc.product-input",
        extract: () => {
          throw new Error("bug");
        },
      },
    };
    const step = new LabelCoreStep({
      artifacts: setup.artifacts,
      remote: setup.remote,
      policies: failing,
    });
    await expect(step.run(setup.input, signal())).rejects.toMatchObject({
      code: "LABEL_CORE.EXTRACTION_FAILED",
    });
  });
});
