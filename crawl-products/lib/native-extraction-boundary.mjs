import { AsyncLocalStorage } from "node:async_hooks";

const native = new AsyncLocalStorage();

export function withNativeExtractionBoundary(enabled, action) {
  return enabled ? native.run(true, action) : action();
}

/** A native hook must not silently delegate back to a whole-page extractor. */
export function assertGenericExtractionAllowed() {
  if (native.getStore() || process.env.CRAWL_DTC_CAPTURE_MODE) {
    throw new Error("DTC.GENERIC_EXTRACTION_FORBIDDEN");
  }
}
