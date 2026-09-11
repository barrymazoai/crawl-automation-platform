import { z } from "zod";
import { CatalogWorkflowInputSchema } from "./catalog.js";
import { VersionTagSchema } from "./artifacts.js";
export const BrandCollectionPlanSchema=z.strictObject({catalog:CatalogWorkflowInputSchema,catalogQueue:VersionTagSchema});
export const BrandCollectionProgressSchema=z.strictObject({catalogId:z.uuid(),settled:z.boolean(),catalog:z.enum(["complete","incomplete","unknown"]),discovered:z.number().int().nonnegative(),finished:z.number().int().nonnegative()});
