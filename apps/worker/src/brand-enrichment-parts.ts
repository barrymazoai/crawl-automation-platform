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
import { CodexTextConfigSchema, createBrandResearchTasks } from "@crawl-automation/processing";
import { SiteAnalysisService, brandEnrichmentErrors } from "@crawl-automation/app";
import { connectTemporal, type TemporalClient } from "@crawl-automation/platform";
import { browserResources } from "@crawl-automation/platform/browser-routing";
import { SiteAnalysisLimitsSchema } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "./core-parts.js";
import { buildBrandStepServices, type BrandEnrichmentTasks } from "./brand-enrichment-services.js";

/**
 * The Codex tasks (Luna medium through `processing.codex.text`, browser tasks in the DTC agent's Ego space) and product
 * delivery. A process that hosts brand enrichment activities needs `processing.codex.text` and `browser.dtcAgent`.
 */
export function brandEnrichmentTaskImplementations(
  parts: CoreParts,
  rpc: SupplySmartRpc,
): BrandEnrichmentTasks {
  const text = parts.config.processing?.codex?.text;
  const browser = parts.config.browser;
  const agent = browser?.dtcAgent;
  if (!text || !browser || !agent) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_WIRED", {
      details: { needs: ["processing.codex.text", "browser.dtcAgent"] },
    });
  }
  const research = createBrandResearchTasks({
    text: CodexTextConfigSchema.parse(text),
    capture: agent.codex,
    ego: browser.ego,
    publication: parts.publication,
    workRoot: agent.codex.workRoot,
    skillPaths: { ego: agent.egoSkillPath, research: [] },
    environment: process.env,
  });
  return {
    family: research.familyCheck,
    researcher: research.researcher,
    judge: research.apolloJudge,
    reviewer: research.reviewer,
    classifier: research.titles,
    delivery: new SupplySmartProductDelivery({
      database: parts.database,
      rpc,
      objects: parts.r2.store,
    }),
  };
}
/** Composition root. Lazy construction does not start intake or poll any business requests. */
export async function buildBrandEnrichmentParts(parts: CoreParts) {
  const config = parts.config.brandEnrichment;
  if (!config) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
  }
  const secrets = await loadBrandEnrichmentSecrets(config.secretsFile);
  const rpc = new SupplySmartRpc(secrets.supplySmart);
  const tasks = lazyTasks(() => brandEnrichmentTaskImplementations(parts, rpc));
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
  return { runs, ...services, closeConnection: () => temporal.close() };
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
      maxWaitSeconds: config.resources.maxWaitSeconds,
      gapAfterSeconds: 0,
    }),
    limits: SiteAnalysisLimitsSchema.parse({ maxBrands: config.limits.subBrands }),
    canEnqueue: true,
  });
}
export type BrandEnrichmentParts = Awaited<ReturnType<typeof buildBrandEnrichmentParts>>;

/** Built on first use and kept: a process that never runs a Codex task never needs its settings. */
function lazyTasks(build: () => BrandEnrichmentTasks): BrandEnrichmentTasks {
  let built: BrandEnrichmentTasks | undefined;
  const tasks = () => (built ??= build());
  return {
    family: { check: (input, signal) => tasks().family.check(input, signal) },
    researcher: { research: (input, signal) => tasks().researcher.research(input, signal) },
    judge: { next: (input, signal) => tasks().judge.next(input, signal) },
    reviewer: { review: (input, signal) => tasks().reviewer.review(input, signal) },
    classifier: { classify: (input, signal) => tasks().classifier.classify(input, signal) },
    delivery: { deliver: (input, signal) => tasks().delivery.deliver(input, signal) },
  };
}

export async function closeBrandEnrichmentParts(parts: Promise<BrandEnrichmentParts>) {
  await (await parts).closeConnection();
}
