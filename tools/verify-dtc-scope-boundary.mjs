import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RetainedPublication } from "../packages/platform/src/index.js";
import { ProductSourcePlans } from "../packages/channels/core/src/index.js";
import { DtcAgentProductCapture } from "../packages/channels/dtc/src/agent/product-capture.js";
import { dtcSitePolicy } from "../packages/channels/dtc/src/site-policy.js";

/** Full host boundary with the real model answer; derivative capture publications stay in memory. */
export async function verifyRetainedScopeBoundary({ config, original, root, captured, result }) {
  const data = new Map();
  const store = { read: async key => data.get(key) ?? null, create: async (key, bytes) => {
    if (data.has(key)) return "exists";
    data.set(key, bytes); return "created";
  } };
  const publication = new RetainedPublication(store, store);
  const sourcePlans = new ProductSourcePlans(publication, { ...config.plan, egressId: "scope-boundary" });
  const url = new URL(original.url);
  const site = dtcSitePolicy({ siteKey: url.hostname, platform: "shopify", catalogUrl: original.sourceUrl });
  const capture = new DtcAgentProductCapture({
    publication, sourcePlans, sites: [site], routeId: "scope-boundary", egressId: "scope-boundary",
    agent: { capture: async () => ({ root, prefix: "scope-boundary", ...captured, manifestKey: "retained-original" }) },
    productScope: { review: async () => {
      assert.ok([...data.keys()].some(key => key.includes("original.html")), "Original must be archived before scope review");
      return result;
    } },
  });
  const outcome = await capture.capture({ ...original, operationId: `scope-boundary-${randomUUID()}` }, new AbortController().signal);
  const projections = [...data.keys()].filter(key => key.endsWith("projection.json"));
  if (result.decision.kind === "multi_product_bundle") {
    assert.equal(outcome.status, "scope-excluded");
    assert.equal(outcome.reason, "DTC.MULTI_PRODUCT_BUNDLE");
    assert.equal(projections.length, 0, "Bundle must not publish a Facts source plan");
  } else {
    assert.equal(outcome.status, "captured");
    assert.ok(outcome.planned?.sourcePlan, "Single product must retain the old source-plan path");
  }
  return { status: outcome.status, projections: projections.length, variants: outcome.variants?.map(v => ({ status: v.status, variantId: v.variant.variantId })) };
}
