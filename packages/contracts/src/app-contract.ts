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
      // 方案 7：分线吞吐（每 stage 的排队/在跑/复核数、近 1h/24h 完成数与平均耗时秒数）。
      stages: z.array(z.object({
        stage: z.string(),
        queued: z.number(),
        active: z.number(),
        needsReview: z.number(),
        completed1h: z.number(),
        completed24h: z.number(),
        avgSeconds24h: z.number().nullable(),
      })).default([]),
      // 正在执行的 job（流水线泳道卡片用）。
      activeJobs: z.array(z.object({
        runId: z.string(),
        stage: z.string(),
        state: z.string(),
        batchId: z.string().nullable(),
        exit: z.string().nullable(),
        url: z.string(),
        adapter: z.string().nullable(),
      })).default([]),
      // worker 心跳上报的遥测：磁盘背压、出口轮动（含当前 IP）、Codex 余量。
      telemetry: z.object({
        disk: z.object({ nodeId: z.string(), freeGb: z.number(), softGb: z.number(), hardGb: z.number(), state: z.enum(["normal", "soft", "hard"]) }).nullable(),
        egress: z.object({ channel: z.string(), exitId: z.string(), ip: z.string().nullable(), exits: z.array(z.string()), updatedAt: z.string() }).nullable(),
        codex: z.object({ fiveHourPercentLeft: z.number().nullable(), weeklyPercentLeft: z.number().nullable(), resetsAt: z.string().nullable(), updatedAt: z.string() }).nullable(),
      }).default({ disk: null, egress: null, codex: null }),
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

