import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { ArtifactResolver, RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { SwansonProductJobSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { SwansonCatalogSource } from "./swanson-catalog-source.js";
import { SwansonLiveProduct } from "./swanson-live-product.js";
import { ChannelProductPlans } from "./channel-plan.js";
export class SwansonMemory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  async read(key: string, max: number) { const b = this.data.get(key); if (b && b.length > max) throw Error("limit"); return b ?? null; }
  async create(key: string, bytes: Uint8Array) { if (this.data.has(key)) return "exists" as const; this.data.set(key, Buffer.from(bytes)); return "created" as const; }
}
export function swansonLiveFixture() {
  const root = process.env.V3_CHANNEL_FIXTURE_ROOT; if (!root) throw Error("Mini fixture root required");
  const sample = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
  const projection = sample("swanson-catalog-public.json"), product = sample("swanson-product-public.json");
  const scope = { brandId: "brand", sourceId: "swanson", channel: "swanson" as const, region: "US",
    rootUrl: "https://www.swansonvitamins.com/collections/brand-ac-grace-company", scopeVersion: "source-revision-1" };
  const input = { catalogId: "catalog", scope, page: 0, cursor: null };
  const local = new SwansonMemory(), remote = new SwansonMemory(), publication = new RetainedPublication(local, remote);
  const browser = { capture: vi.fn(async () => structuredClone(projection)) };
  const catalog = new SwansonCatalogSource(publication, "A.C. Grace Company", browser);
  const settings: ConstructorParameters<typeof SwansonLiveProduct>[1] = { text: { schemaVersion: 1 as const, module: "codex.text", implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const, configFingerprint: "a".repeat(64) },
    ocr: { schemaVersion: 1 as const, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) },
    visionConfigFingerprint: "c".repeat(64), egressId: "host/1" };
  const productBrowser = { capture: vi.fn(async () => structuredClone(product)) }, live = new SwansonLiveProduct(publication, settings, productBrowser);
  const rows = new Map<string, ReviewRecord>(), reviews = { read: async (id: string) => rows.get(id) ?? null, append: async (r: ReviewRecord) => { rows.set(r.reviewId, r); } };
  const plans = new ChannelProductPlans(publication, new ArtifactResolver({ read: async () => null, retain: async () => {} }, remote), reviews);
  async function job() {
    const page = await catalog.read(input, AbortSignal.timeout(1000));
    return SwansonProductJobSchema.parse({ codec: "swanson-product-job/1", operationId: "capture", sessionId: "page",
      discovery: { discoveryId: "discovery", catalogId: "catalog", scope, entry: page.entries.find(e => e.url === product.url), source: page.source, workflowId: "product" },
      queues: { capture: "capture", plan: "plan", file: "file", label: "label", review: "review" },
      resources: { queue: "resource", activities: { browserSession: [{ resourceId: "browser", units: 1 }] } } });
  }
  return { root, sample, projection, product, scope, input, local, remote, publication, browser, catalog, settings, productBrowser, live, plans, job };
}
