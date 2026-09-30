import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { CatalogDiscoverySchema, CatalogExecutionSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects } from "@crawl-automation/v3-artifacts";
import { GncCaptureEvidence, SavedGncCatalogSource } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { artifactBuildId, workerProcess, RoleRegistry } from "@crawl-automation/v3-worker-runtime";
import { readGncPrivateJson } from "./gnc-config.js";
import { PostgresCatalog } from "../../../packages/v3-product/src/catalog-ledger.js";
import { buildGncCatalogProduct, PostgresCatalogProducts } from "../../../packages/v3-product/src/catalog-product.js";
import { CatalogDatabaseConfig, CatalogSourceConfig, CatalogProductConfig } from "./catalog-config.js";
async function main() {
  if (process.env.V3_CATALOG_ENABLED !== "true" || !process.env.V3_CATALOG_CONFIG) throw Error("Catalog opt-in required");
  const raw = await readGncPrivateJson(process.env.V3_CATALOG_CONFIG);
  const output = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await readdir(output)).filter(n => n.endsWith(".js")).sort().map(n => join(output,n)));
  await workerProcess(new RoleRegistry("business", [
    { role: "catalog-source", capability: "catalog.source", compatibility: "catalog-v1" },
    { role: "catalog-ledger", capability: "catalog.ledger", compatibility: "catalog-v1" },
    { role: "presence-check", capability: "presence.check", compatibility: "presence-v1" },
    { role: "catalog-product-input", capability: "catalog.product.workflow", compatibility: "catalog-product-v1" },
  ].map(def => ({ ...def, kind: "activity" as const, contractVersion: 1, buildId, testOnly: false,
    async prepare() {
      const config = def.role === "presence-check" ? CatalogDatabaseConfig.parse(raw) : def.role === "catalog-product-input" ? CatalogProductConfig.parse(raw) : CatalogSourceConfig.parse(raw);
      const db = new pg.Pool({ connectionString: config.database.connectionString, ssl: config.database.tls ? { rejectUnauthorized: true } : false,
        max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
      let r2: ReturnType<typeof createR2Objects> | undefined;
      const dispose = async () => { r2?.close(); await db.end(); };
      try {
        await db.query("SELECT catalog_id FROM catalog_run LIMIT 0");
        let handlers: Record<string, (input: any) => Promise<unknown>>;
        if (def.role === "presence-check") {
          const ledger = new PostgresCatalog(db, async () => { throw Error("CATALOG.CAPABILITY_DENIED"); });
          handlers = { checkPresence: raw => ledger.presence(raw) };
        } else if (def.role === "catalog-product-input") {
          const config = CatalogProductConfig.parse(raw);
          await db.query("SELECT discovery_id,record FROM catalog_product_input LIMIT 0");
          const products = new PostgresCatalogProducts(db);
          handlers = { prepareCatalogProduct: async raw => {
            const d = CatalogDiscoverySchema.parse(raw);
            const info = Context.current().info;
            if (!info.workflowExecution) throw Error("CATALOG.WORKFLOW_REQUIRED");
            const execution = CatalogExecutionSchema.parse({ clusterId: config.clusterId, namespace: info.workflowNamespace,
              workflowId: info.workflowExecution.workflowId, runId: info.workflowExecution.runId });
            return products.prepare(d, execution, verified => {
              const grants = config.products.filter(p => p.discoveryId === verified.discoveryId);
              const factories = config.factories.filter(p => p.catalogId === verified.catalogId);
              if (grants.length + factories.length !== 1) throw Error("CATALOG.PRODUCT_NOT_CONFIGURED");
              return factories.length ? buildGncCatalogProduct(verified, factories[0]) : { input: grants[0]!.input, queue: grants[0]!.queue };
            });
          } };
        } else {
          const config = CatalogSourceConfig.parse(raw);
          r2 = createR2Objects(config.r2, config.r2Credentials);
          const source = new SavedGncCatalogSource(new GncCaptureEvidence({ local: await TextLocalStore.open(config.journalRoot), remote: r2.store, reviews: new PostgresReviews(db) }), config.grants);
          const ledger = new PostgresCatalog(db, p => source.verify(p, AbortSignal.timeout(60000)));
          handlers = def.role === "catalog-source" ? { readCatalogPage: raw => source.read(raw, Context.current().cancellationSignal) }
            : { commitCatalogPage: raw => ledger.commit(raw), recordCatalogDispatch: raw => ledger.dispatch(raw), closeCatalog: raw => ledger.close(raw) };
        }
        return { kind: "activity" as const, dispose, activities: Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (raw: unknown) => {
          const context = Context.current(); if (context.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Inspect original operation", "CATALOG.RETRY_DENIED");
          try { context.cancellationSignal.throwIfAborted(); return await fn(raw); }
          catch (e) { context.cancellationSignal.throwIfAborted(); const code = e instanceof Error && /^(CATALOG|PRESENCE)\.[A-Z_]+$/.test(e.message) ? e.message : "CATALOG.UNRESOLVED";
            throw ApplicationFailure.nonRetryable("Inspect retained catalog evidence", code); }
        }])) };
      } catch (e) { await dispose(); throw e; }
    },
  }))));
}
main().catch(() => { console.error(JSON.stringify({ event: "CATALOG_WORKER_STARTUP_REJECTED" })); process.exitCode = 1; });
