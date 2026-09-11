import { z } from "zod";
import { ExecutionIdSchema, VersionTagSchema } from "./artifacts.js";
/** Public provider selection only. Never contains credentials, cookies or a proxy URL. */
export const ScraperApiRouteSchema = z.strictObject({
  routeId: ExecutionIdSchema, version: VersionTagSchema, egressId: VersionTagSchema,
  mode: z.literal("scraperapi"), managed: z.literal(true),
  countryCode: z.string().regex(/^[a-z]{2}$/),
  sessionNumber: z.number().int().min(0).max(2147483647).nullable(),
  responseMode: z.enum(["html", "rendered-html", "binary"]),
  providerPolicy: z.literal("scraperapi-sync/1"),
});
export type ScraperApiRoute = z.infer<typeof ScraperApiRouteSchema>;
