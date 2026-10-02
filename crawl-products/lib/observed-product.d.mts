export function verifyObservedProduct(root: string, record: {
  productUrl?: string;
  sourceUrl?: string;
  fields: Record<string, unknown>;
  variants?: unknown[];
  fieldEvidence?: unknown;
}): Promise<Array<{ path: string; sha256: string }>>;
export function readObservedProduct(root: string, method: unknown): Promise<{
  sourceUrl: string;
  fields: Record<string, unknown>;
  variants: Array<Record<string, unknown>>;
  fieldEvidence: { sources: Array<{ path: string; sha256: string }> };
}>;
export function readObservedField(root: string, method: unknown, rule: unknown): Promise<unknown>;
