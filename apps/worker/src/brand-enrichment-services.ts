import {
  BrandIdentityService,
  BrandWebsiteService,
  MarketplaceMatchService,
  BrandFamilyService,
  BrandResearchService,
  BrandApolloService,
  BrandWriteService,
  BrandContactsService,
  BrandReviewService,
  BrandOwnershipWriteService,
  BrandProductsService,
  BrandCloseService,
  BrandProductRedelivery,
  type BrandEnrichmentRuns,
  type BrandEnrichmentReviews,
  type SupplySmartCompanies,
  type SupplySmartContacts,
  type BrandRequests,
  type Apollo,
  type SiteAnalysisService,
  type BrandProductExecution,
  type BrandCompanyRepository,
  type MarketplaceBrands,
} from "@crawl-automation/app";
import type { BrandEnrichmentWorkflowSettings } from "@crawl-automation/v3-contracts";
import type {
  FamilyCheck,
  BrandResearcher,
  WebsiteFinder,
  ApolloJudge,
  OwnershipReviewer,
  TitleClassifier,
  ProductDelivery,
} from "@crawl-automation/app";
export interface BrandEnrichmentTasks {
  family: FamilyCheck;
  researcher: BrandResearcher;
  website: WebsiteFinder;
  judge: ApolloJudge;
  reviewer: OwnershipReviewer;
  classifier: TitleClassifier;
  delivery: ProductDelivery;
}

type StepDependencies = {
  runs: BrandEnrichmentRuns;
  reviews: BrandEnrichmentReviews;
  companies: SupplySmartCompanies;
  contacts: SupplySmartContacts;
  requests: BrandRequests;
  apollo: Apollo;
  marketplace: MarketplaceBrands;
  matches: BrandCompanyRepository;
  tasks: BrandEnrichmentTasks;
  analyses: SiteAnalysisService;
  execution: BrandProductExecution;
  config: BrandEnrichmentWorkflowSettings & { reviewerModel: string };
};

export function buildBrandStepServices(deps: StepDependencies) {
  const { runs, companies, reviews, tasks, config } = deps;
  return {
    identity: new BrandIdentityService({ runs, companies, reviews }),
    website: new BrandWebsiteService({ runs, brands: deps.marketplace, finder: tasks.website }),
    marketplaceMatch: new MarketplaceMatchService({ runs, matches: deps.matches }),
    family: new BrandFamilyService({
      runs,
      companies,
      reviews,
      family: tasks.family,
      subBrandLimit: config.limits.subBrands,
    }),
    research: new BrandResearchService({ runs, companies, researcher: tasks.researcher }),
    apollo: new BrandApolloService({
      runs,
      apollo: deps.apollo,
      judge: tasks.judge,
      searchLimit: config.limits.apolloSearches,
    }),
    write: new BrandWriteService({ runs, companies }),
    contacts: new BrandContactsService({
      runs,
      contacts: deps.contacts,
      classifier: tasks.classifier,
    }),
    ...reviewServices(deps),
    ownership: new BrandOwnershipWriteService({ runs, reviews, companies }),
    products: new BrandProductsService({
      runs,
      analyses: deps.analyses,
      delivery: tasks.delivery,
      execution: deps.execution,
    }),
    close: new BrandCloseService({ runs, companies, requests: deps.requests }),
    redelivery: new BrandProductRedelivery({ runs, delivery: tasks.delivery }),
  };
}

function reviewServices(deps: StepDependencies) {
  return {
    review: new BrandReviewService({
      runs: deps.runs,
      reviews: deps.reviews,
      companies: deps.companies,
      reviewer: deps.tasks.reviewer,
      model: deps.config.reviewerModel,
    }),
  };
}
