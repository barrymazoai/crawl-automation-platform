import { ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import {
  ArtifactRefSchema,
  TextInputSchema,
  textFingerprint,
} from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { hashText } from "../results/text-record.js";
import { MemoryStore } from "../../testing/memory-store.js";
import { signal, textFixture } from "../testing/text-fixture.js";
import type { LabelCorePolicies } from "./label-core-policy.js";
import { TextEvidence } from "./text-evidence.js";

const owner = {
  schemaVersion: 1 as const,
  requestId: "req-core",
  observationId: "obs-core",
  brandId: "brand-test",
  sourceId: "source-test",
  listingId: "listing-core",
  variantId: null,
};
const FACTS = "Supplement Facts\nServing Size 1 Scoop";
const PAGE = "<pre>Supplement Facts\nServing Size 1 Scoop</pre>";

/** A label-core document read from a page made by `sourceModule` at `sourceVersion`. */
function labelCoreTask(options: { sourceModule: string; sourceVersion: string; text: string }) {
  const remote = new MemoryStore();
  const ref = (kind: "source-html" | "result-json", bytes: Buffer, producer: object) =>
    ArtifactRefSchema.parse({
      schemaVersion: 1,
      artifactId: `${kind}-core`,
      observationId: owner.observationId,
      sourceId: owner.sourceId,
      listingId: owner.listingId,
      variantId: null,
      kind,
      mediaType: kind === "source-html" ? "text/html" : "application/json",
      objectKey: `core/${kind}`,
      sha256: sha256(bytes),
      byteSize: bytes.length,
      producer,
    });
  const pageBytes = Buffer.from(PAGE);
  const page = ref("source-html", pageBytes, {
    operationId: "plan-core",
    module: options.sourceModule,
    implementationVersion: options.sourceVersion,
  });
  const document = {
    ...owner,
    producer: "label.core.prepare",
    corePolicy: "swanson-label-core/1",
    source: page,
    pageIndex: null,
    text: options.text,
  };
  const documentBytes = Buffer.from(JSON.stringify(document));
  const documentRef = ref("result-json", documentBytes, {
    operationId: "core-op",
    module: "label.core.prepare",
    implementationVersion: "swanson-label-core/1",
  });
  remote.data.set(page.objectKey, pageBytes);
  remote.data.set(documentRef.objectKey, documentBytes);
  const supported = textFixture().input;
  const unsigned = {
    ...owner,
    schemaVersion: 1 as const,
    module: supported.module,
    implementationVersion: supported.implementationVersion,
    policyVersion: supported.policyVersion,
    resultSchemaVersion: supported.resultSchemaVersion,
    configFingerprint: supported.configFingerprint,
    operationId: "text-core",
    source: { kind: "prepared" as const, document: documentRef },
    range: { start: 0, end: options.text.length },
  };
  const input = TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashText),
  });
  return { input, remote };
}

const policies: LabelCorePolicies = {
  "swanson-label-core/1": {
    sourceModule: "channel.product-input",
    sourceVersion: "channel-plan/1",
    extract: (html) => html.replace(/<\/?pre>/g, ""),
  },
};

function evidenceOver(remote: MemoryStore, labelCores: LabelCorePolicies) {
  const artifacts = new ArtifactResolver(
    { read: async () => null, retain: async () => {} },
    remote,
  );
  const ocr = { inspect: async (): Promise<never> => Promise.reject(new Error("no OCR")) };
  return new TextEvidence({ artifacts, ocr, labelCores });
}

describe("TextEvidence", () => {
  it("reads prepared page text and names every artifact it depends on", async () => {
    const given = textFixture();

    const source = await given.evidence.resolve(given.input, signal());

    expect(source.text).toBe(given.text);
    expect(source.refs.map((ref) => ref.objectKey)).toEqual([
      given.ref.objectKey,
      given.source.objectKey,
    ]);
  });

  it("accepts label facts that are exactly what the channel's policy reads from the page", async () => {
    const task = labelCoreTask({
      sourceModule: "channel.product-input",
      sourceVersion: "channel-plan/1",
      text: FACTS,
    });

    const source = await evidenceOver(task.remote, policies).resolve(task.input, signal());

    expect(source.text).toBe(FACTS);
  });

  it.each([
    {
      name: "no policy for the label core",
      labelCores: {},
      sourceModule: "channel.product-input",
      sourceVersion: "channel-plan/1",
      text: FACTS,
    },
    {
      name: "a page from another producer",
      labelCores: policies,
      sourceModule: "gnc.product-input",
      sourceVersion: "channel-plan/1",
      text: FACTS,
    },
    {
      name: "a page from another producer version",
      labelCores: policies,
      sourceModule: "channel.product-input",
      sourceVersion: "channel-plan/2",
      text: FACTS,
    },
    {
      name: "facts text the policy does not produce",
      labelCores: policies,
      sourceModule: "channel.product-input",
      sourceVersion: "channel-plan/1",
      text: "Supplement Facts",
    },
  ])("refuses $name", async (refused) => {
    const task = labelCoreTask(refused);

    await expect(
      evidenceOver(task.remote, refused.labelCores).resolve(task.input, signal()),
    ).rejects.toMatchObject({
      code: "TEXT.SOURCE_CONFLICT",
    });
  });

  it("missing source evidence is unavailable, and the error keeps the underlying reason", async () => {
    const given = textFixture();
    given.remote.data.delete(given.ref.objectKey);

    await expect(given.evidence.resolve(given.input, signal())).rejects.toMatchObject({
      code: "TEXT.EVIDENCE_UNAVAILABLE",
      details: expect.objectContaining({
        executionFact: "not_executed",
        cause: expect.any(String),
      }),
    });
  });
});
