export function missingSiteMethodFields(
  record: unknown,
  productUrl: string,
  galleryUrls?: unknown,
): string[];

export function repeatedSiteMethodIds(productHtml: string, pageHtml: string): string[];
export function repeatedSiteMethodRegionIds(productHtml: string): string[];
export function repeatedSiteMethodMaterialIds(
  materials: unknown,
  notes: unknown,
  record: unknown,
  readHtml: (path: string) => Promise<string>,
): Promise<Array<{ scope: string; ids: string[]; reason?: string }>>;
