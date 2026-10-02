import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { ProductSourcePlans } from "@crawl-automation/channels-core";
import { DtcAgentProductCapture } from "./product-capture.js";
import { retainCaptureDirectory, captureOutputFiles } from "./archive.js";
import { dtcSitePolicy } from "../site-policy.js";

// Mini-only, read-only originals. All derived publications stay in memory; no provider or DB work.
it.skipIf(!process.env["CRAWL_RETAINED_DTC_LEGACY_CAPTURE"])(
  "rejects a legacy Solaray record without field provenance rather than fabricating a current proof",
  async () => {
    await expect(
      retained(process.env["CRAWL_RETAINED_DTC_LEGACY_CAPTURE"] ?? ""),
    ).rejects.toMatchObject({
      code: "DTC.CAPTURE_EVIDENCE",
      details: {
        reason: "observed_method_unverified",
        message: "Error: DTC.OBSERVED_METHOD:method_required",
      },
    });
  },
);
it.skipIf(!process.env["CRAWL_RETAINED_DTC_MULTI_CAPTURE"])(
  "keeps HMW's two old unscoped variants independently unresolved",
  async () => {
    const { result, data } = await retained(process.env["CRAWL_RETAINED_DTC_MULTI_CAPTURE"] ?? "");
    if (result.status !== "captured") {
      throw new Error("Expected archived product");
    }
    expect(
      result.variants?.map((member) => ({
        status: member.status,
        sku: member.variant.sku,
        available: member.variant.available,
        price: member.variant.price,
      })),
    ).toEqual([
      { status: "review", sku: "012", available: false, price: "9.99" },
      { status: "review", sku: "022", available: true, price: "34.99" },
    ]);
    expect(result.variantPages?.map((entry) => entry.page.commerce?.sku)).toEqual(["012", "022"]);
    expect(
      [...data.keys()].filter(
        (key) => key.includes("dtc-variant-") && key.endsWith("projection.json"),
      ),
    ).toHaveLength(0);
    expect(result.variantId).toBeNull();
    expect(result.page.commerce?.sku).toBeNull();
  },
);

it.skipIf(!process.env["CRAWL_RETAINED_DTC_SINGLE_CAPTURE"])(
  "keeps Solaray's single website variant on the existing path",
  async () => {
    const { result } = await retained(process.env["CRAWL_RETAINED_DTC_SINGLE_CAPTURE"] ?? "");
    if (result.status !== "captured") {
      throw new Error("Expected archived product");
    }
    expect(result.variantId).toBe("32703815778364");
    expect(result.variants).toBeUndefined();
    expect(result.planned?.sourcePlan.owner.variantId).toBe("32703815778364");
  },
);

async function retained(workspace: string) {
  const root = join(workspace, "capture");
  const records = JSON.parse(await readFile(join(root, "evidence/records.json"), "utf8"));
  const url: string = records[0].productUrl;
  const site = dtcSitePolicy({
    siteKey: new URL(url).hostname,
    platform: "shopify",
    catalogUrl: `${new URL(url).origin}/collections/all`,
  });
  const data = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, bytes);
      return "created";
    },
  };
  const publication = new RetainedPublication(store, store);
  const signal = new AbortController().signal;
  const prefix = "v3/dtc-agent/retained-variants";
  const files = captureOutputFiles(
    await retainCaptureDirectory(publication, { root: workspace, prefix }, signal),
  );
  const compat = {
    schemaVersion: 1 as const,
    implementationVersion: "test/1",
    policyVersion: "test/1",
    resultSchemaVersion: 2 as const,
    configFingerprint: "a".repeat(64),
  };
  const sourcePlans = new ProductSourcePlans(publication, {
    egressId: "retained-test",
    text: { ...compat, module: "codex.text" },
    ocr: { ...compat, module: "ocr.file" },
    visionConfigFingerprint: "b".repeat(64),
  });
  const capture = new DtcAgentProductCapture({
    publication,
    sourcePlans,
    sites: [site],
    routeId: "retained-test",
    egressId: "retained-test",
    agent: { capture: async () => ({ root, prefix, ...files, manifestKey: "retained-manifest" }) },
  });
  const result = await capture.capture(
    {
      runId: "11111111-1111-4111-8111-111111111111",
      channel: "dtc",
      url,
      brandId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      operationId: "retained-variants",
    },
    signal,
  );
  return { result, data };
}
