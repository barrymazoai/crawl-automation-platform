import { expect, vi } from "vitest";

/** In-memory permit journal used by product pipeline tests. */
export function pipelinePermits(state: { held: boolean }) {
  return {
    prepareResourceExecution: vi.fn(async () => {
      expect(state.held).toBe(true);
    }),
    stopResourceExecution: vi.fn(async (request: { permitId: string }) => ({
      permitId: request.permitId,
      state: "stopped",
      attempts: 1,
    })),
    reserveResources: vi.fn(async (request: { permitId: string }) => {
      state.held = true;
      return { permitId: request.permitId, status: "granted", reason: "available" };
    }),
    releaseResources: vi.fn(async (request: { permitId: string }) => {
      state.held = false;
      return { permitId: request.permitId, status: "released", reason: "released" };
    }),
  };
}
