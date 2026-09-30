import { amazonProductUrl } from "@crawl-automation/channel-amazon";
import { amazonProductForAsin } from "@crawl-automation/channels-wholefoods";

/** Inject Amazon's canonical URL builder; channels never import one another. */
export const amazonFormulaProduct = (asin: string, sourceId: string) =>
  amazonProductForAsin(asin, sourceId, amazonProductUrl);
