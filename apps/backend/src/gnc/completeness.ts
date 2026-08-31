export function isGncDiscoveryIncomplete(input: {
  foundCount: number;
  expectedCount: number | null;
  maxItems: number;
  exhausted: boolean;
  nextUrl: string | null;
}) {
  if (!input.exhausted || input.nextUrl) return true;
  if (input.foundCount > input.maxItems) return true;
  if (input.expectedCount != null && input.expectedCount > input.maxItems) return true;
  if (input.expectedCount != null && input.foundCount < input.expectedCount) return true;
  return false;
}

export function isGncCaptureIncomplete(input: {
  processedUrlCount: number;
  queuedUrlCount: number;
  productCount: number;
  maxItems: number;
  variantOverflow: boolean;
}) {
  if (input.variantOverflow) return true;
  if (input.processedUrlCount < input.queuedUrlCount) return true;
  if (input.productCount > input.maxItems) return true;
  return false;
}
