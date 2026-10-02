import type {
  UsageService,
  EnrichmentBackfill,
  BrandScanService,
  BrandService,
  SiteAnalysisService,
  BrandSourceImport,
  FleetService,
  HistoryService,
  ListingStateService,
  ProductService,
  OriginalEvidenceService,
  QueueService,
  ResourceService,
  ReviewService,
  RunService,
} from "@crawl-automation/app";
import { isAppError, type AppError } from "@crawl-automation/platform";
import { initTRPC, TRPCError } from "@trpc/server";

export interface ApiContext {
  siteAnalyses?: SiteAnalysisService | undefined;
  usage?: UsageService | undefined;
  enrichment?: EnrichmentBackfill;
  runs: RunService;
  queue: QueueService;
  brands: BrandService;
  reviews: ReviewService;
  products: ProductService;
  originals: OriginalEvidenceService;
  history: HistoryService;
  resources: ResourceService;
  fleet: FleetService;
  listingStates: ListingStateService;
  brandScans: BrandScanService;
  brandSources: BrandSourceImport;
}

type TrpcCode = TRPCError["code"];

const conflictCodes = new Set([
  "RUN.SOURCE_BUSY",
  "RUN.REVISION_CONFLICT",
  "REQUEST.ID_CONFLICT",
  "BRAND.REVISION_CONFLICT",
  "BRAND.DUPLICATE",
  "QUEUE.IMPORT_CONFLICT",
  "QUEUE.CLEANUP_PENDING",
  "QUEUE.REQUEUE_NOT_SETTLED",
  "RUN.STILL_RUNNING",
  "RUN.STOP_NOT_PROVEN",
  "PERMIT.OWNER_RUNNING",
  "PERMIT.STOP_NOT_PROVEN",
]);

/** Maps an application error code to the HTTP-level tRPC code. */
function trpcCodeFor(error: AppError): TrpcCode {
  if (error.code.endsWith(".NOT_FOUND")) {
    return "NOT_FOUND";
  }
  if (conflictCodes.has(error.code)) {
    return "CONFLICT";
  }
  return error.category === "VALIDATION" ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
}

const trpc = initTRPC.context<ApiContext>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    const app = isAppError(cause) ? { code: cause.code, details: cause.details } : null;
    return { ...shape, data: { ...shape.data, app } };
  },
});

/** Turns an AppError thrown by a service into a tRPC error with the right status. */
const mapAppErrors = trpc.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && isAppError(result.error.cause)) {
    const cause = result.error.cause;
    throw new TRPCError({ code: trpcCodeFor(cause), message: cause.message, cause });
  }
  return result;
});

export const router = trpc.router;
export const procedure = trpc.procedure.use(mapAppErrors);
