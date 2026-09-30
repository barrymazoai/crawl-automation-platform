import { describe, expect, it } from "vitest";
import {
  LabelCollectedProductSchema,
  PackagingFactsSchema,
  textFingerprint,
} from "@crawl-automation/v3-contracts";
import { assemblySetup, labelCandidate, textEntry } from "../testing/assembly-fixture.js";
import { decodeDrug, drugLines } from "../testing/drug-label-fixture.js";
import { hashString } from "../results/result-record.js";

function setupDrugCollection() {
  const setup = assemblySetup();
  const entry = textEntry(labelCandidate());
  entry.candidate = { ...decodeDrug().candidate, schemaVersion: 3 };
  entry.fullText = drugLines.join("\n");
  const input = entry.record.input;
  input.policyVersion = "label-text/5";
  input.range = { start: 0, end: entry.fullText.length };
  input.inputFingerprint = textFingerprint(input, hashString);
  setup.join.manifest.sources = [{ id: entry.id, kind: "text", required: true, task: input }];
  setup.join.states = [{ id: entry.id, status: "registered" }];
  setup.deps.readSource.mockImplementation(async () => structuredClone(entry));
  return { ...setup, entry };
}

describe("Drug Facts collection", () => {
  it("collects active strengths, Purpose, inactive ingredients and excluded sections with cold readback", async () => {
    const setup = setupDrugCollection();
    const signal = new AbortController().signal;
    const result = await setup.assembly.run(setup.join, signal);
    expect(result.status).toBe("ready");
    const input = { join: setup.join, evidenceKey: result.evidenceKey };
    expect((await setup.collector.run(input, signal)).status).toBe("collected");
    const record = LabelCollectedProductSchema.parse(
      await setup.registry.read(setup.join.manifest.operationId),
    );
    expect(record.formula.servingSize).toBeNull();
    expect(record.formula.servingsPerContainer).toBeNull();
    expect(record.formula.columns[0]?.rows[0]?.purpose).toMatchObject({
      text: "Relieves muscle pain",
      sourceId: setup.entry.id,
      citation: { kind: "text" },
    });
    expect(record.otherIngredients?.items.map((item) => item.text)).toEqual(["lactose", "sucrose"]);
    expect(record.provenance[0]?.candidate.exclusions).toHaveLength(7);
    expect((await setup.cold().collector.run(input, signal)).status).toBe("collected");
    expect(setup.registry.append).toHaveBeenCalledTimes(1);
    const changed = structuredClone(record);
    const purpose = changed.formula.columns[0]?.rows[0]?.purpose;
    if (purpose) {
      purpose.text = "Altered purpose";
    }
    expect(LabelCollectedProductSchema.safeParse(changed).success).toBe(false);
  });

  it("does not require a drug serving size when packaging independently prints one", async () => {
    const setup = setupDrugCollection();
    const source = setup.entry.record.input.source;
    if (source.kind !== "prepared") {
      throw new Error("Expected prepared text");
    }
    const document = source.document;
    setup.join.manifest.admission = { policy: "label-packaging/1", documents: [document] };
    setup.deps.readPackaging.mockResolvedValue(
      PackagingFactsSchema.parse({
        codec: "packaging-facts/1",
        observation: setup.join.manifest.observation,
        productComposition: "unknown",
        containerCount: null,
        servingSize: {
          status: "observed",
          value: "5 pellets",
          claims: [
            {
              document,
              field: "servingSize",
              value: "5 pellets",
              quote: { text: "5 pellets", start: 0, end: 9 },
            },
          ],
        },
        servingsPerContainer: { status: "unknown", value: null, claims: [] },
        unresolvedPackMentions: [],
        warnings: [],
        blockingIssues: [],
      }),
    );
    const signal = new AbortController().signal;
    const result = await setup.assembly.run(setup.join, signal);
    expect(result.status).toBe("ready");
    expect(
      (await setup.collector.run({ join: setup.join, evidenceKey: result.evidenceKey }, signal))
        .status,
    ).toBe("collected");
    const record = LabelCollectedProductSchema.parse(
      await setup.registry.read(setup.join.manifest.operationId),
    );
    expect(record.schemaVersion).toBe(4);
    expect(record.formula.servingSize).toBeNull();
  });

  it("rejects a forged Purpose citation before assembly", async () => {
    const setup = setupDrugCollection();
    const purpose = setup.entry.candidate.formula?.columns[0]?.rows[0]?.purpose;
    if (purpose) {
      purpose.start++;
    }
    const result = await setup.assembly.run(setup.join, new AbortController().signal);
    expect(result.status).toBe("review");
    expect(setup.registry.append).not.toHaveBeenCalled();
  });
});
