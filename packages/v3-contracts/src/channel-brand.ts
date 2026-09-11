import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";
const name = z.string().trim().min(1).max(200);
export const SwansonBrandDirectorySchema = z.strictObject({
  codec: z.literal("swanson-brand-directory/1"), url: z.literal("https://www.swansonvitamins.com/pages/brands"),
  capturedAt: z.iso.datetime(), title: name, searchValue: z.string().max(200),
  entries: z.array(z.strictObject({ name, url: z.url().max(2000) })).min(1).max(5000),
});
export type SwansonBrandDirectory = z.infer<typeof SwansonBrandDirectorySchema>;
export const ResolveChannelBrandInputSchema = z.strictObject({
  operationId: ExecutionIdSchema, brandId: ExecutionIdSchema, brandRevision: z.number().int().positive(),
  channel: z.literal("swanson"), region: z.literal("US"), name,
  aliases: z.array(name).max(20).default([]), existingUrl: z.url().max(2000).nullable().default(null),
});
export type ResolveChannelBrandInput = z.infer<typeof ResolveChannelBrandInputSchema>;
export const ChannelBrandDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("resolved"), input: ResolveChannelBrandInputSchema,
    url: z.url(), matchedName: name.nullable(), basis: z.enum(["existing-source", "exact-name", "explicit-alias"]) }),
  z.strictObject({ status: z.literal("review"), input: ResolveChannelBrandInputSchema,
    code: z.enum(["BRAND_LINK.NOT_FOUND", "BRAND_LINK.AMBIGUOUS", "BRAND_LINK.DIRECTORY_FILTERED"]),
    candidates: z.array(z.strictObject({ name, url: z.url() })).max(5000), automaticRetry: z.literal(false) }),
]);
export type ChannelBrandDecision = z.infer<typeof ChannelBrandDecisionSchema>;
