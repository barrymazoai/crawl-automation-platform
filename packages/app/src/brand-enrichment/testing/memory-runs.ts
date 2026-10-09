import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { BrandEnrichmentRun, OwnershipClue } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "../ports.js";
import { brandEnrichmentErrors } from "../errors.js";

export function memoryRuns() {
  const records = new Map<string, BrandEnrichmentRun>();
  const steps = new Map<string, unknown>();
  const clues = new Map<string, OwnershipClue[]>();
  const tries = new Map<string, number>();
  const runs = {
    ...createPort(records),
    get: vi.fn<BrandEnrichmentRuns["get"]>(async (id) => records.get(id) ?? null),
    list: vi.fn<BrandEnrichmentRuns["list"]>(async (filter) =>
      [...records.values()]
        .filter(
          (run) =>
            (!filter.state || run.state === filter.state) &&
            (!filter.parentRunId || run.parentRunId === filter.parentRunId),
        )
        .slice(0, filter.limit),
    ),
    update: vi.fn<BrandEnrichmentRuns["update"]>(async (id, change) => {
      const run = records.get(id);
      if (!run) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND");
      }
      const updated = { ...run, ...change };
      records.set(id, updated);
      return updated;
    }),
    ...stepLedger({ steps, clues, tries }),
  } satisfies BrandEnrichmentRuns;
  return { runs, records, steps };
}
function createPort(records: Map<string, BrandEnrichmentRun>) {
  return {
    create: vi.fn<BrandEnrichmentRuns["create"]>(async (input) => {
      const live = [...records.values()].find(
        (run) => input.requestId && run.requestId === input.requestId && run.state === "running",
      );
      if (live) {
        return { run: live, created: false };
      }
      const run: BrandEnrichmentRun = {
        ...input,
        state: "running",
        companyId: null,
        stage: null,
        summary: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      records.set(input.runId, run);
      return { run, created: true };
    }),
  };
}
function stepLedger(input: {
  steps: Map<string, unknown>;
  clues: Map<string, OwnershipClue[]>;
  tries: Map<string, number>;
}) {
  const { steps, clues, tries } = input;
  return {
    saveStep: vi.fn<BrandEnrichmentRuns["saveStep"]>(async (input) => {
      const key = `${input.runId}/${input.step}`;
      if (!steps.has(key)) {
        steps.set(key, input.output);
      }
      return steps.get(key);
    }),
    step: vi.fn<BrandEnrichmentRuns["step"]>(
      async (id, step) => steps.get(`${id}/${step}`) ?? null,
    ),
    addClues: vi.fn<BrandEnrichmentRuns["addClues"]>(async (id, added) => {
      clues.set(id, [...(clues.get(id) ?? []), ...added]);
    }),
    clues: vi.fn<BrandEnrichmentRuns["clues"]>(async (id) => clues.get(id) ?? []),
    recordApolloTry: vi.fn<BrandEnrichmentRuns["recordApolloTry"]>(async (id, attempt) => {
      if (attempt.attempt > 3) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE");
      }
      tries.set(id, attempt.attempt);
    }),
    apolloTries: vi.fn<BrandEnrichmentRuns["apolloTries"]>(async (id) => tries.get(id) ?? 0),
  };
}
export async function seededRuns(role: BrandEnrichmentRun["role"] = "request") {
  const memory = memoryRuns();
  const runId = randomUUID();
  const companyId = randomUUID();
  await memory.runs.create({
    runId,
    requestId: role === "request" ? randomUUID() : null,
    parentRunId: null,
    role,
    brandName: "Example Nutrition",
    brandUrl: "https://example.test",
    workflowId: `brand-enrichment-${runId}`,
  });
  await memory.runs.update(runId, { companyId });
  return { ...memory, runId, companyId };
}
