export interface DetailRecord {
  fields: Record<string, unknown>;
  fieldEvidence?: unknown;
  gallery?: Array<{ url: string }>;
}
export function verifyObservedDetails(root: string, record: DetailRecord, review: unknown): Promise<{
  evidence: string[]; fields: string[]; imageUrls: string[];
}>;
export function saveObservedDetails(root: string, record: DetailRecord, review: unknown): Promise<{
  detailCoveragePath: string; passed: true;
}>;
