import { createDtcAdapter, type DtcSitePolicy } from "@crawl-automation/channel-dtc";
import { wholeFoodsAdapter, WHOLE_FOODS_STORE } from "@crawl-automation/channels-wholefoods";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";

/** The channels whose product pages this API reads addresses of (product and list runs). */
export function channelRegistry(dtcSites: readonly DtcSitePolicy[] = []): ChannelRegistry {
  return new ChannelRegistry([
    swansonAdapter,
    gncAdapter,
    amazonAdapter,
    wholeFoodsAdapter(WHOLE_FOODS_STORE),
    createDtcAdapter(dtcSites),
  ]);
}
