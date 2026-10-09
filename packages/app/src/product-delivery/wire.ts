import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";

export interface DeliveryRun {
  runId: string;
  channel: "dtc";
  scope: "full" | "partial";
  siteKey: string;
  companyDomain: string;
  startedAt: string;
  source: string;
}
export interface DeliveryImage {
  clientRef: string;
  url: string;
  role?: string;
}
export interface DeliveryListing {
  externalId: string;
  sourceUrl: string;
  productUrl: string;
  siteKey: string;
  productName: string;
  titleRaw: string;
  brandName?: string;
  baseName?: string;
  productForm?: string;
  healthFunctions?: string[];
  mainIngredients?: string[];
  variant?: Record<string, string | { value: number; unit: string }>;
  variantConfidence?: number;
  variantSource?: "ai_extract";
  price?: string | undefined;
  currency?: string | undefined;
  inStock?: boolean | undefined;
  listPrice?: string | undefined;
  rating?: number | undefined;
  reviewCount?: number | undefined;
  salesRank?: number | undefined;
  unitsSold?: number | undefined;
  unitsSoldPeriod?: "trailing_30d" | "monthly" | "lifetime" | "unknown" | undefined;
  extras: Record<string, unknown>;
  attrsRaw: Record<string, unknown>;
}
export interface DeliveryItem extends DeliveryListing {
  clientRef: string;
  domain: string;
  capturedAt: string;
  images: DeliveryImage[];
}
export interface DeliveryLabelContent {
  codec: string;
  formula: LabelCollectedProduct["formula"];
  otherIngredients: LabelCollectedProduct["otherIngredients"];
  formulaComplete: boolean;
  ingredientsComplete: boolean;
  warnings: LabelCollectedProduct["warnings"];
  exclusions: never[];
  issues: never[];
}
export interface DeliveryLabel {
  schemaVersion: 1;
  submitter: { namespace: string; operationId: string };
  observation: Omit<LabelCollectedProduct["observation"], "schemaVersion"> & { capturedAt: string };
  company: { domain: string; expectedCompanyId: string };
  channel: "dtc";
  source: string;
  listing: DeliveryListing;
  images: DeliveryImage[];
  label: {
    content: DeliveryLabelContent;
    evidence: Record<string, unknown>;
  };
}
export interface MappedDelivery {
  item: DeliveryItem;
  label: DeliveryLabel;
}
