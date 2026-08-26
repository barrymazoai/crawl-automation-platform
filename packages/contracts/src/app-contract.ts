import { oc } from "@orpc/contract";
import { z } from "zod";
import { ChannelStatSchema, NodeSchema, ReviewSchema, RunListItemSchema, UrlClassificationSchema } from "./index";

const empty = z.object({}).default({});

export const appContract = {
  dashboard: {
    summary: oc.input(empty).output(z.object({
      runs: z.object({ total: z.number(), active: z.number(), needsReview: z.number(), failed: z.number(), completed: z.number() }),
      nodes: z.object({ online: z.number(), total: z.number() }),
      jobs: z.record(z.string(), z.number()),
    })),
  },
  classify: {
    urls: oc.input(z.object({ urls: z.array(z.string()).min(1).max(500) })).output(z.array(UrlClassificationSchema)),
  },
  runs: {
    list: oc.input(z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) })).output(z.array(RunListItemSchema)),
    get: oc.input(z.object({ id: z.uuid() })).output(z.unknown()),
    create: oc.input(z.object({
      urls: z.array(z.string()).min(1).max(500),
      mode: z.enum(["one_off", "recurring"]).default("one_off"),
      scheduleCron: z.string().nullable().optional(),
      scheduleTimezone: z.string().default("Asia/Shanghai"),
    })).output(z.object({ created: z.array(RunListItemSchema), rejected: z.array(UrlClassificationSchema) })),
  },
  nodes: { list: oc.input(empty).output(z.array(NodeSchema)) },
  reviews: {
    list: oc.input(z.object({ status: z.string().default("open") })).output(z.array(ReviewSchema)),
    resolve: oc.input(z.object({ id: z.uuid(), action: z.enum(["retry", "resume", "abandon"]), resolution: z.string().min(1) })).output(z.object({ success: z.boolean() })),
  },
  channels: { list: oc.input(empty).output(z.array(ChannelStatSchema)) },
  debug: {
    prompt: oc.input(z.object({ url: z.url(), runId: z.uuid(), jobDirectory: z.string() })).output(z.object({ prompt: z.string() })),
  },
};

export type AppContract = typeof appContract;

