import { vi } from "vitest";
import type { ListingPolicyRequest } from "@crawl-automation/channels-core";
import { createWholeFoodsHttpReader } from "./whole-foods-http-reader.js";
import { WholeFoodsHttpScanSettingsSchema } from "./whole-foods-http-settings.js";
import { wholeFoodsBrandSearchUrl } from "./whole-foods-address.js";

export const sourceUrl = wholeFoodsBrandSearchUrl({
  name: "Nordic Naturals",
  amazonBrandId: "234060",
});
const asin = (number: number) => `B0${String(number).padStart(8, "0")}`;
export const answer = (ids: number[], total = ids.length) =>
  JSON.stringify({
    mainResultSet: {
      searchResults: ids.map((number) => ({ asin: asin(number), parentAsin: asin(999) })),
      availableTotalResultCount: total,
      approximateTotalResultCount: 9999,
    },
    deliveryTargets: [],
    searchRobotSignals: {},
  });

export function setup(answers: (string | Error)[], config: Record<string, unknown> = {}) {
  const settings = WholeFoodsHttpScanSettingsSchema.parse(config);
  const reader = createWholeFoodsHttpReader(settings);
  const readList = reader.readList;
  if (!readList) {
    throw new Error("HTTP reader must provide its policy");
  }
  let index = 0;
  const read = vi.fn(async (request: ListingPolicyRequest) => {
    const body = answers[index++];
    if (body instanceof Error) {
      throw body;
    }
    if (body === undefined) {
      throw new Error("Unexpected extra paid request");
    }
    return { body, archiveKey: `${request.label}.json`, creditCost: 1, fromArchive: false };
  });
  const pause = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
  const controller = new AbortController();
  return {
    reader,
    settings,
    read,
    pause,
    controller,
    run: () => readList({ sourceUrl, read, pause, signal: controller.signal }),
  };
}
