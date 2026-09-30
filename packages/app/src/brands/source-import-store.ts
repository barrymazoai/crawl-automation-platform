import type { ScanChannel } from "../brand-scans/scan-model.js";

export interface BrandName {
  brandId: string;
  name: string;
}

/** Existing brands and disabled source insertion; existing rows are never updated. */
export interface BrandSourceImportStore {
  brandNames(): Promise<BrandName[]>;
  addDisabledSources(
    rows: readonly { brandId: string; channel: ScanChannel; url: string }[],
  ): Promise<{ created: number; existing: number }>;
}
