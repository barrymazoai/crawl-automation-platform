import {
  EvidenceService,
  type EvidenceChannels,
  type EvidencePages,
  type EvidencePageFactory,
} from "@crawl-automation/app";
import {
  createR2Objects,
  ScraperApiClient,
  type R2Scope,
  type ScraperApiAccess,
} from "@crawl-automation/platform";
import type { ScraperApiRoute } from "@crawl-automation/v3-contracts";
import { EvidenceArchive } from "./evidence-archive.js";
import { HttpEvidenceCapture } from "./http-evidence-capture.js";
import { singleRequestClient } from "./single-request-client.js";

export interface EvidenceStorage {
  r2: R2Scope;
  r2Credentials: { accessKeyId: string; secretAccessKey: string };
}

interface EvidenceHttpSettings {
  route: ScraperApiRoute;
  scraperApi: ScraperApiAccess;
  channels: Parameters<EvidencePageFactory>[1]["channels"];
}

/** Uses the existing object store with a separate test scope; production prefixes are never used here. */
export function createEvidenceService(parts: {
  testPrefix?: string | undefined;
  capture?: EvidenceHttpSettings | undefined;
  storage: EvidenceStorage | undefined;
  channels: EvidenceChannels;
  createPages: EvidencePageFactory;
}): EvidenceService {
  const { testPrefix, storage, channels, capture } = parts;
  if (!testPrefix || !storage || !capture) {
    return new EvidenceService();
  }
  const remote = createR2Objects({ ...storage.r2, prefix: testPrefix }, storage.r2Credentials);
  const archive = new EvidenceArchive(remote.store, testPrefix);
  const pages = (tier?: Tier) => evidencePages(capture, parts.createPages, tier);
  return new EvidenceService(new HttpEvidenceCapture({ channels, pages, archive }));
}

type Tier = Parameters<EvidencePages>[0];

/** A tier named for one request replaces premium / ultra premium in that channel's options, for that request. */
function withTier(channels: EvidenceHttpSettings["channels"], named: Tier) {
  if (!named?.tier) {
    return channels;
  }
  const { channel, tier } = named;
  const chosen = { premium: tier === "premium", ultraPremium: tier === "ultraPremium" };
  return { ...channels, [channel]: { ...channels[channel], ...chosen } };
}

function evidencePages(
  capture: EvidenceHttpSettings,
  createPages: EvidencePageFactory,
  tier?: Tier,
) {
  const { route, scraperApi } = capture;
  const channels = withTier(capture.channels, tier);
  const client = singleRequestClient(new ScraperApiClient(scraperApi));
  return createPages(client, {
    routeId: route.routeId,
    egressId: route.egressId,
    channels,
    defaults: {
      countryCode: route.countryCode,
      sessionNumber: route.sessionNumber,
      render: route.responseMode === "rendered-html",
      premium: false,
    },
  });
}
