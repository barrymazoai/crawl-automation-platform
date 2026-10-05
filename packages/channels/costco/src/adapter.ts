import type { ChannelAdapter, ProductIdentity } from "@crawl-automation/channels-core";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { costcoProductAddress, costcoProductUrl } from "./address.js";
import { costcoBrandReader } from "./brand-scan.js";
import { costcoPageIdentity } from "./identity.js";
import { COSTCO_IMAGE_ORIGINS, COSTCO_PAGE_POLICY } from "./policy.js";
import { costcoFacts, parseCostcoProduct, type CostcoProduct } from "./product.js";
import { COSTCO_STORE, type CostcoStore } from "./store.js";
import { costcoErrors } from "./errors.js";

/** A child (`#item=`) must name the same item in the task, the evidence and both addresses. */
function readProjection(raw: unknown, url: string, owner: ProductIdentity) {
  const evidence = ChannelProductEvidenceSchema.parse(raw);
  const expected = costcoProductAddress(url);
  const actual = costcoProductAddress(evidence.url);
  const sameListing = [evidence.listingId, actual.listingId, expected.listingId].every(
    (id) => id === owner.listingId,
  );
  const sameChild = [evidence.variantId, actual.variantId, expected.variantId].every(
    (id) => id === owner.variantId,
  );
  if (evidence.channel !== "costco" || !sameListing || !sameChild) {
    throw costcoErrors.create("COSTCO.PROJECTION_CONFLICT");
  }
  return { evidence, facts: costcoFacts(evidence) };
}

/** Costco owns its formula by channel + online listing ID; metrics always carry warehouse context. */
export function costcoAdapter(store: CostcoStore = COSTCO_STORE): ChannelAdapter<CostcoProduct> {
  return {
    id: "costco",
    captureModes: ["http"],
    httpPolicy: COSTCO_PAGE_POLICY,
    fileOrigins: COSTCO_IMAGE_ORIGINS,
    brandScan: costcoBrandReader(store),
    scanCapture: () => "browser",
    productAddress: costcoProductAddress,
    productUrl: costcoProductUrl,
    pageIdentity: costcoPageIdentity,
    planning: {
      channel: "costco",
      parserVersion: "costco-rendered/1",
      projectionModule: "costco.http-projection",
      projection: (rendered) => rendered.evidence,
      read: readProjection,
    },
    discoversVariants: true,
    parseProduct(page) {
      const rendered = parseCostcoProduct(page, store);
      return {
        channel: "costco",
        identity: {
          listingId: rendered.evidence.listingId,
          variantId: rendered.evidence.variantId,
        },
        rendered,
        evidence: rendered.evidence,
        commerce: rendered.commerce,
        variants: costcoChildVariants(rendered),
        facts: costcoFacts(rendered.evidence),
      };
    },
  };
}

/** The page's other children, each by its own `#item=` address; the plain page stands for the default child. */
function costcoChildVariants(rendered: CostcoProduct) {
  const { selected, children } = rendered.children;
  if (children.length < 2) {
    return [];
  }
  return children
    .filter((child) => child.itemNumber !== selected)
    .map((child) => costcoProductAddress(`${rendered.pageUrl}#item=${child.itemNumber}`));
}
