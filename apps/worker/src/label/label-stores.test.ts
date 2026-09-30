import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { gncAdapter, gncLabelCore } from "@crawl-automation/channels-gnc";
import { swansonAdapter, swansonLabelCore } from "@crawl-automation/channel-swanson";
import { LabelCoreStep } from "@crawl-automation/processing";
import { ArtifactResolver, sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import {
  ArtifactRefSchema,
  ObservationSchema,
  TextDocumentSchema,
} from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { labelCorePolicies } from "./label-stores.js";

const registry = new ChannelRegistry([gncAdapter, swansonAdapter]);
const signal = () => AbortSignal.timeout(5_000);

/** The existing saved GNC page, using exactly the selected facts/details the planning hook publishes. */
function gncFragment() {
  const fixture = new URL(
    "../../../../packages/channels/gnc/src/fixtures/product-877080.html.gz",
    import.meta.url,
  );
  const parsed = gncAdapter.parseProduct({
    url: "https://www.gnc.com/vitamin-d/877080.html",
    html: gunzipSync(readFileSync(fixture)).toString(),
    capturedAt: "2026-09-30T08:00:00.000Z",
  });
  return Buffer.from(
    [
      ...parsed.evidence.factsCandidates
        .filter((facts) => facts.scope === "selected-product")
        .map((facts) => facts.html),
      parsed.evidence.detailsHtml,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** In-memory retained source and page.prepare document; no provider, database or model calls. */
function savedPage() {
  const owner = ObservationSchema.parse({
    schemaVersion: 1,
    requestId: "request",
    observationId: "observation",
    brandId: "brand",
    sourceId: "source",
    listingId: "877080",
    variantId: null,
  });
  const bytes = gncFragment();
  const source = ArtifactRefSchema.parse({
    schemaVersion: owner.schemaVersion,
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: owner.variantId,
    artifactId: "gnc-fragment",
    kind: "source-html",
    mediaType: "text/html",
    objectKey: "test/gnc-derived.html",
    byteSize: bytes.length,
    sha256: sha256(bytes),
    producer: {
      operationId: "plan",
      module: gncAdapter.planning?.labelCore?.sourceModule,
      implementationVersion: "channel-plan/1",
    },
  });
  const full = Buffer.from(
    JSON.stringify({
      ...owner,
      producer: "page.prepare",
      pageIndex: null,
      source,
      text: "Full prepared page",
    }),
  );
  const fullDocument = ArtifactRefSchema.parse({
    ...source,
    artifactId: "full-page",
    kind: "result-json",
    mediaType: "application/json",
    objectKey: "test/full.json",
    byteSize: full.length,
    sha256: sha256(full),
    producer: { operationId: "page", module: "page.prepare", implementationVersion: "1" },
  });
  return {
    source,
    input: { owner, fullDocument },
    data: new Map([
      [source.objectKey, bytes],
      [fullDocument.objectKey, full],
    ]),
  };
}

describe("worker label-core registration", () => {
  it("registers GNC alongside Swanson from their planning hooks", () => {
    const policies = labelCorePolicies(registry);
    expect(policies["gnc-label-core/1"]).toBe(gncLabelCore);
    expect(policies["swanson-label-core/1"]).toBe(swansonLabelCore);
    expect(gncAdapter.planning?.corePolicy).toBe("gnc-label-core/1");
  });

  it("runs and reads back the GNC label core step on the saved page's facts", async () => {
    const { source, input, data } = savedPage();
    const remote: ObjectStore = {
      read: async (key) => data.get(key) ?? null,
      create: async (key, bytes) => {
        if (data.has(key)) {
          return "exists";
        }
        data.set(key, Buffer.from(bytes));
        return "created";
      },
    };
    const artifacts = new ArtifactResolver(
      { read: async () => null, retain: async () => {} },
      remote,
    );
    const step = new LabelCoreStep({ artifacts, remote, policies: labelCorePolicies(registry) });
    const result = await step.run(input, signal());
    expect(result.status).toBe("prepared");
    const document = TextDocumentSchema.parse(
      JSON.parse(data.get(result.document.objectKey)?.toString() ?? "null"),
    );
    expect(document).toMatchObject({
      producer: "label.core.prepare",
      corePolicy: "gnc-label-core/1",
      listingId: "877080",
      source,
    });
    expect(source.producer.module).toBe("gnc.product-input");
    expect(document.text).toMatch(/Serving Size/i);
    expect(document.text).toContain("Vitamin D3");
    expect(document.text).toContain("Other Ingredients");
    expect(await step.inspect(input, signal())).toEqual(result);
  });
});
