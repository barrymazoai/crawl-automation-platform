import { appErrors } from "@crawl-automation/app";
import { expect, it, vi } from "vitest";
import { appWith, query, post } from "./testing/app-with.js";

const scanId = "11111111-1111-4111-8111-111111111111";
const archiveKey = `v3/brand-scans/${scanId}/read-1-page-1-attempt-1.json`;

it.each([{ scanId }, { scanId, archiveKey }])(
  "routes a read-only scan evidence query without authentication: %j",
  async (input) => {
    const result = { scanId, answers: [] };
    const evidence = vi.fn(async () => result);
    const response = await appWith({ brandScans: { evidence } }).request(
      `/trpc/brands.scanEvidence${query(input)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: result } });
    expect(evidence).toHaveBeenCalledExactlyOnceWith(input);
  },
);

it.each([{ scanId: "invalid" }, { scanId, archiveKey: "" }, { scanId, unknown: true }])(
  "rejects invalid evidence input before the service: %j",
  async (input) => {
    const evidence = vi.fn();
    const response = await appWith({ brandScans: { evidence } }).request(
      `/trpc/brands.scanEvidence${query(input)}`,
    );
    expect(response.status).toBe(400);
    expect(evidence).not.toHaveBeenCalled();
  },
);

it("does not expose evidence as a mutation", async () => {
  const evidence = vi.fn();
  const response = await appWith({ brandScans: { evidence } }).request(
    "/trpc/brands.scanEvidence",
    post({ scanId }),
  );
  expect(response.status).toBe(405);
  expect(evidence).not.toHaveBeenCalled();
});

it.each(["SCAN.NOT_FOUND", "EVIDENCE.NOT_FOUND"] as const)("maps %s to 404", async (code) => {
  const evidence = vi.fn(async () => {
    throw appErrors.create(code);
  });
  const response = await appWith({ brandScans: { evidence } }).request(
    `/trpc/brands.scanEvidence${query({ scanId, archiveKey })}`,
  );
  expect(response.status).toBe(404);
  expect((await response.json()).error.data.app.code).toBe(code);
});
