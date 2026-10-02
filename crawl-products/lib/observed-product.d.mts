export function verifyObservedProduct(root: string, record: {
  productUrl?: string;
  sourceUrl?: string;
  fields: Record<string, unknown>;
  variants?: unknown[];
  fieldEvidence?: unknown;
}): Promise<Array<{ path: string; sha256: string }>>;
