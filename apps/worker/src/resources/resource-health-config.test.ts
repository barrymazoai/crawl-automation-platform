import { describe, expect, it } from "vitest";
import { WorkerConfigSchema } from "../config.js";

const schema = WorkerConfigSchema.shape.resourceHealth;
const settings = {
  controller: '["test-host","/test/root"]',
  minFreeBytes: 1_000,
  diskPath: "/test/root",
  resources: { cpu: { taskQueues: ["label"] } },
};

describe("resource health settings", () => {
  it("is optional for existing configs and supplies the refresh defaults", () => {
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse(settings)).toEqual({ ...settings, intervalMs: 5_000, ttlMs: 15_000 });
  });

  it("preserves the controller verbatim and accepts the fleet OCR settings", () => {
    const config = {
      ...settings,
      resources: { ocr: { taskQueues: ["ocr"], ocr: true } },
      ocrApi: { baseUrl: "https://ocr.example.test", provider: "paddle/1" },
    };
    expect(schema.parse(config)).toMatchObject({
      controller: settings.controller,
      ocrApi: { ...config.ocrApi, timeoutMs: 45_000 },
    });
  });

  it.each(["mini-ego-space-1", "server2-ego-space-6", "costco-brand-scan"])(
    "maps browser resource %s to the shared browser queue without OCR",
    (resourceId) => {
      const resources = { [resourceId]: { taskQueues: ["v3.browser.wholefoods.v1"] } };
      expect(schema.parse({ ...settings, resources })).toMatchObject({ resources });
    },
  );

  it.each([
    { controller: "" },
    { intervalMs: 0 },
    { ttlMs: 0 },
    { intervalMs: 15_000 },
    { minFreeBytes: -1 },
    { diskPath: "relative" },
    { resources: { cpu: { taskQueues: [] } } },
    { resources: { cpu: { taskQueues: [""] } } },
    { resources: { ocr: { taskQueues: ["ocr"], ocr: true } } },
    { ocrApi: { baseUrl: "invalid", provider: "paddle/1" } },
  ])("refuses invalid monitoring settings: %j", (change) => {
    expect(schema.safeParse({ ...settings, ...change }).success).toBe(false);
  });
});
