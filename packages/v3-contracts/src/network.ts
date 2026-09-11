import { z } from "zod";
import { ExecutionIdSchema, VersionTagSchema } from "./artifacts.js";
import { ScraperApiRouteSchema } from "./scraperapi.js";

export const NetworkCapabilitySchema = z.enum(["http", "binary", "rendered-html", "interactive-browser"]);
export type NetworkCapability = z.infer<typeof NetworkCapabilitySchema>;
// Public selection metadata only; no proxy URL, credential or browser handle in workflow history.
const base = { routeId: ExecutionIdSchema, version: VersionTagSchema, egressId: VersionTagSchema };
export const NetworkRouteSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...base, mode: z.literal("host"), managed: z.literal(false) }),
  z.strictObject({ ...base, mode: z.literal("direct"), managed: z.literal(true), egressId: z.literal("direct/1") }),
  z.strictObject({ ...base, mode: z.literal("static-proxy"), managed: z.literal(true) }),
  ScraperApiRouteSchema,
]);
export type NetworkRoute = z.infer<typeof NetworkRouteSchema>;
