import type { EvidenceChannels, EvidenceCaptureRequest } from "@crawl-automation/app";
import { scraperApiErrors, sha256, type ObjectStore } from "@crawl-automation/platform";
import { EvidenceArchive } from "./evidence-archive.js";
import { HttpEvidenceCapture } from "./http-evidence-capture.js";

/** In-memory evidence boundary for unit tests; records ordering without any network transport. */
export function evidenceFixture() {
  const objects = new Map<string, Uint8Array>();
  const events: string[] = [];
  const source = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("<html>原始\r\n</html>"), 0xff]);
  const store: ObjectStore = {
    async create(key, bytes) {
      events.push(`create:${key}`);
      if (objects.has(key)) {
        return "exists";
      }
      objects.set(key, Uint8Array.from(bytes));
      return "created";
    },
    async read(key) {
      events.push(`read:${key}`);
      return objects.get(key) ?? null;
    },
  };
  const fetchedVia = { mode: "http" as const, routeId: "test", egressId: "test", provider: "fake" };
  const pages = {
    mode: "http" as const,
    async fetchPage() {
      events.push("fetch");
      return { bytes: source, fetchedVia };
    },
  };
  const archive = new EvidenceArchive(store, "tests/v3/pages");
  const capture = new HttpEvidenceCapture({
    channels: fakeChannels(events),
    pages: () => pages,
    archive,
  });
  return { objects, events, source, store, pages, archive, capture, expectedHash: sha256(source) };
}

export const captureRequest: EvidenceCaptureRequest = {
  channel: "gnc",
  url: "https://page.test/products/123456",
  note: "test sample",
  maximumAttempts: 1,
};

function fakeChannels(events: string[]): EvidenceChannels {
  return {
    forCapture(channel, mode) {
      events.push(`channel:${channel}:${mode}`);
      return {
        id: channel,
        captureModes: ["http"],
        httpPolicy: { origins: ["https://page.test"], maxBytes: 1024, timeoutMs: 1000 },
        productAddress(url) {
          events.push("address");
          if (new URL(url).origin !== "https://page.test") {
            throw scraperApiErrors.create("SOURCE.ORIGIN_BLOCKED");
          }
          return { url, listingId: "123456", variantId: "789" };
        },
        parseProduct() {
          throw new Error("Test evidence must never be parsed");
        },
      };
    },
  };
}
