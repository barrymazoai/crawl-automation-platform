import { expect, it, vi } from "vitest";
import { labelCoreErrors } from "@crawl-automation/platform/errors/label-core";
import { orderedFixture } from "./ordered-fixture.js";
import { labelCandidate } from "../testing/label-sources.js";
import { LabelPlans } from "./label-plans.js";
import { labelPlanSetup } from "../testing/label-fixture.js";

const signal = () => AbortSignal.timeout(5_000);
const verdict = (reason = "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS") => ({
  id: "a-text",
  status: "not_matched" as const,
  reason,
});
const registered = { id: "source-0", status: "registered" as const };

it.each(Object.keys(labelCoreErrors.codes))("continues after the page verdict %s", async (code) => {
  const fixture = await orderedFixture({ order: "text-first" });
  const input = { ...fixture.input, corePolicy: "test-core/1" };
  const request = { input, states: [verdict(code)] };
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({
    complete: false,
    terminal: false,
    reason: { sourceId: "a-text", code, executionFact: "executed" },
  });
  expect(fixture.plans.source).not.toHaveBeenCalled();
  expect(
    await fixture.selection.inspect({ input, states: [...request.states, registered] }, signal()),
  ).toMatchObject({ complete: true, terminal: false });
  expect(fixture.plans.source.mock.calls.map(([call]) => call.sourceId)).toEqual(["source-0"]);
});

it.each(["unresolved", "rejected"])("keeps a page with %s execution terminal", async (status) => {
  const fixture = await orderedFixture({ order: "text-first" });
  expect(
    await fixture.selection.inspect(
      { input: fixture.input, states: [{ id: "a-text", status }] },
      signal(),
    ),
  ).toMatchObject({
    complete: false,
    terminal: true,
    reason: { code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED", executionFact: "unknown" },
  });
  expect(fixture.plans.source).not.toHaveBeenCalled();
});

it.each([
  "LABEL_CORE.IDENTITY_CONFLICT",
  "LABEL_CORE.HANDOFF_UNVERIFIED",
  "LABEL_CORE.EXTRACTION_FAILED",
])("refuses to treat %s as a content verdict", async (reason) => {
  const fixture = await orderedFixture({ order: "text-first" });
  await expect(
    fixture.selection.inspect(
      {
        input: { ...fixture.input, corePolicy: "test-core/1" },
        states: [verdict(reason)],
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
});

it("rejects a verdict on an image or a page without a core policy", async () => {
  const fixture = await orderedFixture();
  await expect(
    fixture.selection.inspect(
      {
        input: { ...fixture.input, corePolicy: "test-core/1" },
        states: [{ ...verdict(), id: "source-0" }],
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
  const page = await orderedFixture({ order: "text-first" });
  await expect(
    page.selection.inspect({ input: page.input, states: [verdict()] }, signal()),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
});

it("skips the failed core in the manifest but retains full-page packaging evidence and the cause", async () => {
  const fixture = await orderedFixture({ order: "text-first" });
  const input = { ...fixture.input, corePolicy: "test-core/1", admission: "label-packaging/1" };
  const fullDocuments = vi.fn(async () => [{ artifactId: "full-page" }]);
  Object.assign(fixture.plans, { fullDocuments });
  await fixture.selection.manifest(
    {
      input,
      selectedImageId: null,
      states: [verdict(), registered, { id: "source-1", status: "not_started" }],
    },
    signal(),
  );
  expect(fullDocuments).toHaveBeenCalledOnce();
  expect(fixture.plans.publishManifest).toHaveBeenCalledWith(
    expect.objectContaining({
      sources: [fixture.tasks.get("source-0")],
      skipped: ["a-text", "source-1"],
      documents: [{ artifactId: "full-page" }],
    }),
    expect.any(AbortSignal),
  );
  expect(fixture.plans.publish).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      decisions: expect.arrayContaining([
        { id: "a-text", action: "skipped", reason: "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS" },
      ]),
    }),
    expect.any(AbortSignal),
  );
});

it("retains both the parser cause and the incomplete image cause", async () => {
  const partial = labelCandidate();
  partial.formulaComplete = false;
  const fixture = await orderedFixture({ order: "text-first", candidates: [partial] });
  const check = await fixture.selection.inspect(
    {
      input: { ...fixture.input, corePolicy: "test-core/1" },
      states: [verdict(), registered],
    },
    signal(),
  );
  expect(check).toMatchObject({
    complete: false,
    terminal: false,
    reason: { sourceId: "source-0" },
  });
  expect(check.failures).toEqual([
    expect.objectContaining({ sourceId: "a-text", code: "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS" }),
    expect.objectContaining({ sourceId: "source-0" }),
  ]);
});

it("re-verifies an ordinary page not_matched result before falling back", async () => {
  const fixture = await orderedFixture({ order: "text-first" });
  fixture.plans.source.mockResolvedValue({
    status: "not_matched",
    input: { sourceId: "a-text" },
    source: undefined,
  });
  const request = { input: fixture.input, states: [{ id: "a-text", status: "not_matched" }] };
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({
    complete: false,
    terminal: false,
  });
  expect(fixture.plans.source).toHaveBeenCalledOnce();
  fixture.plans.source.mockResolvedValue({
    status: "prepared",
    input: { sourceId: "a-text" },
    source: fixture.tasks.get("a-text"),
  });
  await expect(fixture.selection.inspect(request, signal())).rejects.toMatchObject({
    code: "CHANNEL.LABEL_IDENTITY_CONFLICT",
  });
});

it("permits a resolved page not_matched only for ordered plans", async () => {
  const setup = await labelPlanSetup();
  const resolve = vi.fn(async () => ({ status: "not_matched" as const }));
  const plans = new LabelPlans({ plans: setup.plans, publication: setup.publication, resolve });
  const input = {
    ...setup.input,
    sourcePolicy: { version: "label-sources/1", order: "text-first" },
    evidencePolicy: "label-image-first/6",
  };
  expect(await plans.source({ input, sourceId: "page" }, signal())).toMatchObject({
    status: "not_matched",
  });
  await expect(
    plans.source({ input: setup.input, sourceId: "page" }, signal()),
  ).rejects.toMatchObject({ code: "CHANNEL.LABEL_IDENTITY_CONFLICT" });
});
