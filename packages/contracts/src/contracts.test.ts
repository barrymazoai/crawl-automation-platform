import { describe, expect, it } from "vitest";
import { EvidenceBundleV1Schema } from "./index";

describe("EvidenceBundleV1", () => {
  it("rejects a mismatched item count", () => {
    const result = EvidenceBundleV1Schema.safeParse({
      schemaVersion: "1.0",
      runId: "9e098108-aab7-4c4e-8f47-27122de73590",
      batchId: "9600232d-431a-4796-bc65-3fd06836fd5f",
      ordinal: 0,
      sourceUrl: "https://example.com",
      sourceType: "dtc_browser",
      adapter: null,
      capturedAt: new Date().toISOString(),
      itemCount: 1,
      items: [],
      files: [],
      capture: { nodeId: "windows-1", promptVersion: "v1", skillRevision: null, pageCount: 1, complete: true },
    });
    expect(result.success).toBe(false);
  });
});

