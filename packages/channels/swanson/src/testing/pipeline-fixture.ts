import { readFileSync } from "node:fs";
import {
  ChannelRegistry,
  ProductPlans,
  ProductSourcePlans,
  type PlanSettings,
} from "@crawl-automation/channels-core";
import {
  ArtifactResolver,
  RetainedPublication,
  verifyBytes,
  type ObjectStore,
} from "@crawl-automation/platform";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { swansonAdapter } from "../adapter.js";

function memoryObjects(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    read: async (key) => objects.get(key) ?? null,
    create: async (key, bytes) => {
      if (objects.has(key)) {
        return "exists";
      }
      objects.set(key, Buffer.from(bytes));
      return "created";
    },
  };
}

const settings: PlanSettings = {
  text: {
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2,
    configFingerprint: "a".repeat(64),
  },
  ocr: {
    schemaVersion: 1,
    module: "ocr.file",
    implementationVersion: "1",
    policyVersion: "1",
    resultSchemaVersion: 2,
    configFingerprint: "b".repeat(64),
  },
  visionConfigFingerprint: "c".repeat(64),
  egressId: "host/1",
};

async function sourcePlanFixture(publication: RetainedPublication, signal: AbortSignal) {
  const product = JSON.parse(
    readFileSync(new URL("../fixtures/swanson-product-public.json", import.meta.url), "utf8"),
  );
  const planning = swansonAdapter.planning;
  if (!planning) {
    throw new Error("Swanson fixture requires its planning hook");
  }
  const selected = product.selectedForms[0];
  const identity = { listingId: selected.productId, variantId: selected.variantIds[0] };
  const planned = planning.read(product, product.url, identity);
  return new ProductSourcePlans(publication, settings).publish(
    {
      runId: "fixture-run",
      channel: "swanson",
      url: product.url,
      brandId: "brand",
      sourceId: "swanson",
      operationId: "capture",
    },
    {
      planning,
      parsed: {
        channel: "swanson",
        identity,
        rendered: product,
        evidence: planned.evidence,
        commerce: product.commerce ?? null,
        variants: [],
        facts: planned.facts,
      },
    },
    signal,
  );
}

/** Shared offline fixture for application/workflow tests, through the current projection and plan APIs. */
export async function swansonPipelineFixture(signal: AbortSignal) {
  const publication = new RetainedPublication(memoryObjects(), memoryObjects());
  const sourcePlan = await sourcePlanFixture(publication, signal);
  const rows = new Map<string, ReviewRecord>();
  const plans = new ProductPlans({
    registry: new ChannelRegistry([swansonAdapter]),
    publication,
    resolver: new ArtifactResolver(
      { read: async () => null, retain: async () => undefined },
      publication.remote,
    ),
    reviews: {
      read: async (id) => rows.get(id) ?? null,
      append: async (record) => rows.set(record.reviewId, record),
    },
    integrity: { verifyBytes },
  });
  return { sourcePlan, settings, plans };
}
