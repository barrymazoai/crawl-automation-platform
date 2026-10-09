import {
  ApolloClient,
  loadBrandEnrichmentSecrets,
  PostgresBrandEnrichmentRuns,
  PostgresBrandEnrichmentReviews,
  SupplySmartRpc,
  SupplySmartBrandRequests,
  SupplySmartCompaniesClient,
  SupplySmartContactsClient,
  PostgresSiteAnalyses,
  PostgresBrandScans,
  PostgresResourceStore,
  TemporalSiteAnalyses,
  TemporalBrandEnrichmentProducts,
  SupplySmartProductDelivery,
} from "@crawl-automation/adapters";
import {
  CodexTextConfigSchema,
  createBrandBrowserTasks,
  createBrandTextTasks,
} from "@crawl-automation/processing";
import { SiteAnalysisService, brandEnrichmentErrors } from "@crawl-automation/app";
import { connectTemporal, type TemporalClient } from "@crawl-automation/platform";
import { browserResources } from "@crawl-automation/platform/browser-routing";
import { SiteAnalysisLimitsSchema } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "./core-parts.js";
import { buildBrandStepServices, type BrandEnrichmentTasks } from "./brand-enrichment-services.js";
import { buildBrandRedeliverySweep } from "./brand-redelivery-parts.js";

/**
 * The Codex tasks and product delivery, built per kind on first use. Text turns (Apollo judge, reviewer, titles)
 * need `processing.codex.text` (Server 一, Luna medium); browser tasks (family, research) need `browser.dtcAgent`
 * (the Ego workers on Server 二), whose Codex settings they run with.
 */
export function brandEnrichmentTaskImplementations(
  parts: CoreParts,
  rpc: SupplySmartRpc,
): BrandEnrichmentTasks {
  const text = once(() =>
    createBrandTextTasks({ text: textSettings(parts), environment: process.env }),
  );
  const browser = once(() => createBrandBrowserTasks(browserSettings(parts)));
  const delivery = once(
    () =>
      new SupplySmartProductDelivery({ database: parts.database, rpc, objects: parts.r2.store }),
  );
  return {
    family: { check: (input, signal) => browser().familyCheck.check(input, signal) },
    researcher: { research: (input, signal) => browser().researcher.research(input, signal) },
    judge: { next: (input, signal) => text().apolloJudge.next(input, signal) },
    reviewer: { review: (input, signal) => text().reviewer.review(input, signal) },
    classifier: { classify: (input, signal) => text().titles.classify(input, signal) },
    delivery: { deliver: (input, signal) => delivery().deliver(input, signal) },
  };
}

function textSettings(parts: CoreParts) {
  const text = parts.config.processing?.codex?.text;
  if (!text) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_WIRED", {
      details: { needs: "processing.codex.text" },
    });
  }
  return CodexTextConfigSchema.parse(text);
}

function browserSettings(parts: CoreParts) {
  const browser = parts.config.browser;
  const agent = browser?.dtcAgent;
  if (!browser || !agent) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_WIRED", {
      details: { needs: "browser.dtcAgent" },
    });
  }
  return {
    text: CodexTextConfigSchema.parse(agent.codex),
    capture: agent.codex,
    ego: browser.ego,
    publication: parts.publication,
    workRoot: agent.codex.workRoot,
    skillPaths: { ego: agent.egoSkillPath, research: [] },
    environment: process.env,
  };
}

function once<Value>(build: () => Value): () => Value {
  let built: Value | undefined;
  return () => (built ??= build());
}

/** Composition root. Lazy construction does not start intake or poll any business requests. */
export async function buildBrandEnrichmentParts(parts: CoreParts) {
  const config = parts.config.brandEnrichment;
  if (!config) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
  }
  const secrets = await loadBrandEnrichmentSecrets(config.secretsFile);
  const rpc = new SupplySmartRpc(secrets.supplySmart);
  const tasks = brandEnrichmentTaskImplementations(parts, rpc);
  const runs = new PostgresBrandEnrichmentRuns(parts.database);
  const temporal = await connectTemporal(parts.config.temporal);
  const services = buildBrandStepServices({
    runs,
    config,
    tasks,
    analyses: siteAnalyses(parts, temporal),
    reviews: new PostgresBrandEnrichmentReviews(parts.database),
    companies: new SupplySmartCompaniesClient(rpc),
    contacts: new SupplySmartContactsClient(rpc),
    requests: new SupplySmartBrandRequests(rpc),
    apollo: new ApolloClient(secrets.apollo),
    execution: new TemporalBrandEnrichmentProducts({
      client: temporal.client,
      scans: new PostgresBrandScans(parts.database),
      permits: new PostgresResourceStore(parts.database),
    }),
  });
  const redeliverySweep = buildBrandRedeliverySweep(parts, {
    redelivery: services.redelivery,
    lookbackDays: config.limits.redeliveryLookbackDays,
  });
  return { runs, ...services, redeliverySweep, closeConnection: () => temporal.close() };
}
function siteAnalyses(parts: CoreParts, temporal: TemporalClient) {
  const config = parts.config.brandEnrichment;
  if (!config) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
  }
  const needs = config.resources.activities["brandFamily"] ?? [];
  const resourceId = browserResources(needs.map((need) => need.resourceId))[0];
  if (!resourceId) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
  }
  return new SiteAnalysisService({
    store: new PostgresSiteAnalyses(parts.database),
    gateway: new TemporalSiteAnalyses(temporal.client, {
      taskQueue: config.queues.browser,
      resourceQueue: config.resources.queue,
      resourceId,
      // The DTC site analysis runs Codex too, so it also takes the family check's model permit (2026-10-09).
      additionalResources: needs.filter((need) => need.resourceId !== resourceId),
      maxWaitSeconds: config.resources.maxWaitSeconds,
      gapAfterSeconds: 0,
    }),
    limits: SiteAnalysisLimitsSchema.parse({ maxBrands: config.limits.subBrands }),
    canEnqueue: true,
  });
}
export type BrandEnrichmentParts = Awaited<ReturnType<typeof buildBrandEnrichmentParts>>;

export async function closeBrandEnrichmentParts(parts: Promise<BrandEnrichmentParts>) {
  await (await parts).closeConnection();
}
