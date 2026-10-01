import { CHANNEL_IDS } from "@crawl-automation/v3-contracts";
import { z } from "zod";

export const UsageWindowSchema = z
  .strictObject({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    channel: z.enum(CHANNEL_IDS).optional(),
  })
  .refine((input) => Date.parse(input.from) < Date.parse(input.to), {
    message: "from must precede to",
  });
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export interface ChannelUsage {
  channel: string;
  products: number;
  attempts: number;
  freshCaptures: number;
  captureReuses: number;
  credits: number;
  unknownCreditCalls: number;
  modelTextCalls: number;
  modelImageCalls: number;
  modelEnrichmentCalls: number;
  ocrCalls: number;
  brandRequests: number;
  brandReuses: number;
  preparationsRecomputed: number;
  preparationsReused: number;
  inputTokens: number;
  outputTokens: number;
  modelCallsWithoutTokens: number;
}

export interface StepUsage {
  channel: string;
  step: string;
  kind: string;
  samples: number;
  medianMs: number;
  p90Ms: number;
}

export interface UsageSummary {
  channels: ChannelUsage[];
  steps: StepUsage[];
  unattributedEvents: number;
}

export interface UsageReader {
  summarize(window: UsageWindow): Promise<UsageSummary>;
}
