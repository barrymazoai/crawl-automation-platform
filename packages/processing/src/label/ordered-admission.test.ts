import { expect, it } from "vitest";
import { LabelManifestResultSchema, labelKeys } from "./label-plan-model.js";
import { admissionStates, orderedAdmissionFixture } from "./ordered-admission-fixture.js";
import { decodeJson } from "../results/result-record.js";
import { defined } from "../testing/defined.js";
import { assemblySetup, labelCandidate } from "../testing/assembly-fixture.js";
import { manifestAdmission } from "./label-manifest-admission.js";

const signal = () => AbortSignal.timeout(10_000);

it.each(["OCR.JOB_FAILED", "OCR.TIMEOUT"])(
  "publishes and collects the complete image after a verified %s in an image-only plan",
  async (code) => {
    const fixture = await orderedAdmissionFixture({ code });
    const progress = await fixture.selection.imageCheck(
      { input: fixture.input, states: admissionStates },
      signal(),
    );
    expect(progress).toMatchObject({
      complete: true,
      terminal: false,
      failures: expect.arrayContaining([{ sourceId: "image-3", code, executionFact: "executed" }]),
    });
    const result = await fixture.selection.manifest(fixture.request, signal());
    expect(LabelManifestResultSchema.parse(result)).toEqual(result);
    expect(result.input).toEqual(fixture.input);
    expect(result.manifest.sources.map((source) => source.id)).toEqual(["image-4"]);
    expect(result.manifest.admission).toBeUndefined();
    expect(result.skipped).toEqual([
      "image-0",
      "image-1",
      "image-2",
      "image-3",
      "image-5",
      "image-6",
    ]);
    const stored = await fixture.publication.remote.read(
      labelKeys.manifest(fixture.input),
      2_000_000,
      signal(),
    );
    expect(decodeJson(defined(stored))).toEqual(result);
    const source = defined(result.manifest.sources[0]);
    const assembly = assemblySetup();
    assembly.deps.readSource.mockImplementation((entry) =>
      fixture.inspector.readSource(
        defined(result.manifest.sources.find((selected) => selected.id === entry.id)),
      ),
    );
    const join = { manifest: result.manifest, states: [{ id: source.id, status: "registered" }] };
    const assembled = await assembly.assembly.run(join, signal());
    expect(assembled.status).toBe("ready");
    expect(
      await assembly.collector.run({ join, evidenceKey: assembled.evidenceKey }, signal()),
    ).toMatchObject({ status: "collected" });
    expect(assembly.registry.append).toHaveBeenCalledOnce();
    expect(defined([...assembly.collected.values()][0])).toMatchObject({
      schemaVersion: 3,
      evidencePolicy: "label-image-first/6",
      provenance: [expect.objectContaining({ id: "image-4" })],
    });
    expect(assembly.deps.readPackaging).not.toHaveBeenCalled();
    expect(fixture.inspector.readSource.mock.calls.every(([entry]) => entry.id === "image-4")).toBe(
      true,
    );
    expect(
      fixture.resolve.mock.calls.some(([entry]) => ["image-5", "image-6"].includes(entry.id)),
    ).toBe(false);
  },
);

it("retains a full prepared page for admission even though only the image supplies the label", async () => {
  const fixture = await orderedAdmissionFixture({ page: true });
  const result = await fixture.selection.manifest(fixture.request, signal());
  expect(result.manifest.sources.map((source) => source.id)).toEqual(["image-4"]);
  const prepared = fixture.prepared.source;
  expect(result.manifest.admission).toEqual({
    policy: "label-packaging/1",
    comparison: "label-typography/2",
    documents: prepared.kind === "prepared" ? [prepared.document] : [],
  });
});

it("rejects an empty admission list when the verified ordered plan has a page", async () => {
  const fixture = await orderedAdmissionFixture({ page: true });
  await expect(
    manifestAdmission(fixture.labelPlans, { input: fixture.input, documents: [] }, signal()),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SOURCE_UNVERIFIED" });
});

it("does not extend the image-only admission exception to legacy tasks", async () => {
  const fixture = await orderedAdmissionFixture();
  const { sourcePolicy: _unused, ...input } = fixture.input;
  await expect(
    manifestAdmission(fixture.labelPlans, { input, documents: [] }, signal()),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SOURCE_UNVERIFIED" });
});

it("refuses missing planned page evidence instead of disabling admission", async () => {
  const fixture = await orderedAdmissionFixture({ page: true });
  fixture.resolutions.set("page", { status: "review", code: "SAVED.PAGE_UNCONFIRMED" });
  await expect(fixture.selection.manifest(fixture.request, signal())).rejects.toMatchObject({
    code: "CHANNEL.LABEL_SOURCE_UNVERIFIED",
  });
  expect(
    await fixture.publication.remote.read(labelKeys.manifest(fixture.input), 2_000_000, signal()),
  ).toBeNull();
});

it.each(["formulaComplete", "ingredientsComplete"] as const)(
  "keeps walking when the registered image has %s=false and preserves source codes",
  async (field) => {
    const candidate = labelCandidate();
    candidate[field] = false;
    const fixture = await orderedAdmissionFixture({ candidate });
    const checked = await fixture.selection.imageCheck(
      { input: fixture.input, states: admissionStates },
      signal(),
    );
    expect(checked).toMatchObject({
      complete: false,
      terminal: false,
      reason: { sourceId: "image-4", executionFact: "executed" },
      failures: expect.arrayContaining([
        { sourceId: "image-0", code: "CHANNEL.LABEL_NO_SOURCE", executionFact: "executed" },
        { sourceId: "image-1", code: "CHANNEL.LABEL_NO_SOURCE", executionFact: "executed" },
        { sourceId: "image-2", code: "CHANNEL.LABEL_NO_SOURCE", executionFact: "executed" },
        { sourceId: "image-3", code: "OCR.JOB_FAILED", executionFact: "executed" },
        expect.objectContaining({ sourceId: "image-4", code: expect.any(String) }),
      ]),
    });
    await expect(fixture.selection.manifest(fixture.request, signal())).rejects.toMatchObject({
      code: "CHANNEL.LABEL_SELECTION_UNVERIFIED",
    });
    expect(
      await fixture.publication.remote.read(labelKeys.manifest(fixture.input), 2_000_000, signal()),
    ).toBeNull();
  },
);

it("keeps unknown OCR execution terminal even beside the complete registered image", async () => {
  const fixture = await orderedAdmissionFixture({ executionFact: "unknown" });
  expect(
    await fixture.selection.imageCheck({ input: fixture.input, states: admissionStates }, signal()),
  ).toMatchObject({
    complete: false,
    terminal: true,
    failures: expect.arrayContaining([
      { sourceId: "image-3", code: "OCR.JOB_FAILED", executionFact: "unknown" },
    ]),
  });
  await expect(fixture.selection.manifest(fixture.request, signal())).rejects.toMatchObject({
    code: "CHANNEL.LABEL_SELECTION_UNVERIFIED",
  });
});

it("continues to a later complete image when the registered image is incomplete", async () => {
  const partial = labelCandidate();
  partial.formula = null;
  partial.formulaComplete = false;
  const fixture = await orderedAdmissionFixture();
  const read = defined(fixture.inspector.readSource.getMockImplementation());
  fixture.inspector.readSource.mockImplementation(async (source) => ({
    ...(await read(source)),
    candidate: source.id === "image-4" ? partial : labelCandidate(),
  }));
  const request = { input: fixture.input, states: admissionStates };
  expect(await fixture.selection.imageCheck(request, signal())).toMatchObject({
    complete: false,
    terminal: false,
  });
  const states = [...admissionStates, { id: "image-5", status: "registered" as const }];
  expect(await fixture.selection.imageCheck({ ...request, states }, signal())).toMatchObject({
    complete: true,
    terminal: false,
  });
  const result = await fixture.selection.manifest(
    { ...fixture.request, states: [...states, { id: "image-6", status: "not_started" }] },
    signal(),
  );
  expect(result.manifest.sources.map((source) => source.id)).toEqual(["image-4", "image-5"]);
});

it("ends an exhausted incomplete walk with content reasons for every attempted source", async () => {
  const candidate = labelCandidate();
  candidate.formulaComplete = false;
  const fixture = await orderedAdmissionFixture({ candidate });
  const states = [
    ...admissionStates,
    { id: "image-5", status: "registered" as const },
    { id: "image-6", status: "registered" as const },
  ];
  const check = await fixture.selection.imageCheck({ input: fixture.input, states }, signal());
  expect(check).toMatchObject({
    complete: false,
    terminal: false,
    // Equal information now keeps the latest source's outcome, not the first one's.
    reason: { sourceId: "image-6", executionFact: "executed" },
    failures: expect.arrayContaining(
      states.map((state) =>
        expect.objectContaining({ sourceId: state.id, code: expect.any(String) }),
      ),
    ),
  });
});
