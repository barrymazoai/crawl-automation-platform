import type {
  ChannelRegistry,
  PageFetcher,
  ScraperApiCaptureSettings,
} from "@crawl-automation/channels-core";
import type { ScraperApiClient } from "@crawl-automation/platform";
import type { EvidenceCaptureInput, EvidenceCaptureResult } from "./evidence-model.js";

/** A manual capture has one paid attempt, including redirect hops; it is never automatically retried. */
export interface EvidenceCaptureRequest extends EvidenceCaptureInput {
  maximumAttempts: 1;
}

/** Resolves the channel address, captures original bytes and verifies their immutable test archive. */
export interface EvidenceCapture {
  capture(request: EvidenceCaptureRequest, signal: AbortSignal): Promise<EvidenceCaptureResult>;
}

/** Channel hooks supplied by the composition root; adapters do not import individual websites. */
export type EvidenceChannels = Pick<ChannelRegistry, "forCapture">;

/** Must refuse before fetching if the provider cannot guarantee a single paid request. */
export type EvidencePages = () => PageFetcher;

export type EvidencePageFactory = (
  client: Pick<ScraperApiClient, "get" | "provider">,
  settings: ScraperApiCaptureSettings,
) => PageFetcher;
