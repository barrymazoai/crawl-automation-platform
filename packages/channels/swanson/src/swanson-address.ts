import { channelErrors } from "@crawl-automation/channels-core";
import { swansonErrors } from "./swanson-errors.js";

export const SWANSON_ORIGIN = "https://www.swansonvitamins.com";

/** An https URL on www.swansonvitamins.com without port, credentials or fragment; anything else is refused. */
export function swansonUrl(raw: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch (error) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { cause: error });
  }
  const own = url.protocol === "https:" && url.hostname === "www.swansonvitamins.com";
  if (!own || url.port || url.username || url.password || url.hash) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: raw } });
  }
  return url;
}

export interface SwansonAddress {
  url: URL;
  handle: string;
  variantId: string | null;
}

const PRODUCT_PATH = /^\/(?:collections\/[a-z0-9-]+\/)?p\/([a-z0-9][a-z0-9-]*)$/;

/** A product page: `/p/<handle>` (optionally under a collection) with at most one numeric `variant` parameter. */
export function swansonProductAddress(raw: string): SwansonAddress {
  const url = swansonUrl(raw);
  const handle = url.pathname.match(PRODUCT_PATH)?.[1];
  const params = [...url.searchParams.keys()];
  const variants = url.searchParams.getAll("variant");
  const variantId = url.searchParams.get("variant");
  const badVariant = variants.length > 1 || (variantId !== null && !/^\d+$/.test(variantId));
  if (!handle || params.some((key) => key !== "variant") || badVariant) {
    throw swansonErrors.create("SWANSON.PRODUCT_URL_UNVERIFIED", { details: { url: raw } });
  }
  return { url, handle, variantId };
}
