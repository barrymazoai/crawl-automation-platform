import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcquireFileModule,
  FileEvidence,
  ResolveAcquiredFile,
  acquisitionKey,
  type FileEvidenceStores,
} from "@crawl-automation/channels-core";
import { ArtifactError } from "@crawl-automation/v3-artifacts";
import { AcquireFileModule as OldModule, FileEvidence as OldEvidence } from "../handoff.js";
import { fileFixture, png, response, signal, type Fixture } from "./file-fixture.js";

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-30T00:00:00Z");
});
afterEach(() => vi.useRealTimers());

type ModuleFactory = (fixture: Fixture) => Pick<AcquireFileModule, "run">;
const factories: ModuleFactory[] = [
  (fixture) => new OldModule(new OldEvidence(fixture.deps), fixture.source),
  (fixture) => new AcquireFileModule(new FileEvidence(fixture.deps), fixture.source),
];
const codes = {
  normal: "durable",
  refused: "SOURCE.HTTP_STATUS",
  intentUnknown: "ACQUIRE.INTENT_UNKNOWN",
  completionUnknown: "durable",
  sourceUnavailable: "ARTIFACT.UNAVAILABLE",
  sourceUnknown: "durable",
  handoffPending: "ACQUIRE.HANDOFF_PENDING",
};
type Scenario = keyof typeof codes;

function configure(fixture: Fixture, scenario: Scenario) {
  if (scenario === "refused") fixture.get.mockImplementation(async () => response(png, {}, 403));
  if (scenario === "handoffPending")
    fixture.local.objects.set(acquisitionKey(fixture.input), Buffer.from("pending"));
  const create = fixture.remote.store.create;
  fixture.remote.store.create = async (...args) => {
    const key = args[0];
    if (scenario === "sourceUnavailable" && key.endsWith("/source"))
      throw new ArtifactError("ARTIFACT.UNAVAILABLE");
    const result = await create(...args);
    if (scenario === "sourceUnknown" && key.endsWith("/source"))
      throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    if (
      (scenario === "intentUnknown" && key.startsWith("acquisition-intents/")) ||
      (scenario === "completionUnknown" && key === acquisitionKey(fixture.input))
    )
      throw Error("lost acknowledgement");
    return result;
  };
}

async function runScenario(factory: ModuleFactory, scenario: Scenario) {
  const fixture = fileFixture();
  configure(fixture, scenario);
  const outcome = await factory(fixture).run(fixture.input, signal());
  return {
    outcome,
    local: [...fixture.local.objects],
    remote: [...fixture.remote.objects],
    retained: [...fixture.retained],
    reviews: [...fixture.reviews],
    localCalls: fixture.local.calls,
    remoteCalls: fixture.remote.calls,
    downloads: fixture.get.mock.calls.length,
    releases: fixture.release.mock.calls.length,
  };
}

describe("file.acquire/1 persisted compatibility", () => {
  it.each(Object.keys(codes) as Scenario[])(
    "%s: identical bytes, keys, hashes, Reviews and I/O",
    async (scenario) => {
      const [previous, current] = await Promise.all(
        factories.map((factory) => runScenario(factory, scenario)),
      );
      expect(current).toEqual(previous);
      expect(
        current?.outcome.status === "review" ? current.outcome.code : current?.outcome.status,
      ).toBe(codes[scenario]);
      expect(current?.downloads).toBe(scenario === "intentUnknown" ? 0 : 1);
    },
  );

  it.each(factories)(
    "replays a verified completion on a fresh worker without a download or write",
    async (factory) => {
      const fixture = fileFixture();
      const outcome = await factory(fixture).run(fixture.input, signal());
      const writes = fixture.remote.calls.filter(([kind]) => kind === "create").length;
      const fresh = fileFixture();
      const deps: FileEvidenceStores = { ...fresh.deps, remote: fixture.remote.store };
      const evidence = new FileEvidence(deps);
      expect(
        await new AcquireFileModule(evidence, fresh.source).run(fixture.input, signal()),
      ).toEqual(outcome);
      expect(await new ResolveAcquiredFile(evidence).run(fixture.input, signal())).toEqual(outcome);
      expect(fresh.get).not.toHaveBeenCalled();
      expect(fixture.remote.calls.filter(([kind]) => kind === "create")).toHaveLength(writes);
    },
  );

  it("the earlier worker reads a completion the new worker wrote", async () => {
    const fixture = fileFixture();
    const outcome = await factories[1]!(fixture).run(fixture.input, signal());
    expect(await factories[0]!(fixture).run(fixture.input, signal())).toEqual(outcome);
    expect(fixture.get).toHaveBeenCalledOnce();
  });

  it.each(factories)(
    "never repeats a failed download, including with a fresh local journal",
    async (factory) => {
      const fixture = fileFixture();
      fixture.get.mockImplementation(async () => response(png, {}, 403));
      expect(await factory(fixture).run(fixture.input, signal())).toMatchObject({
        status: "review",
        code: "SOURCE.HTTP_STATUS",
      });
      fixture.deps.local = fileFixture().deps.local;
      expect(await factory(fixture).run(fixture.input, signal())).toMatchObject({
        status: "review",
        code: "ACQUIRE.EXECUTION_UNKNOWN",
      });
      expect(fixture.get).toHaveBeenCalledOnce();
    },
  );

  it("rejects corrupt saved bytes without downloading again", async () => {
    const fixture = fileFixture();
    const module = factories[1]!(fixture);
    const outcome = await module.run(fixture.input, signal());
    if (outcome.status !== "durable") throw Error("expected a durable receipt");
    fixture.remote.objects.set(outcome.file.objectKey, Buffer.from("corrupt"));
    expect(await module.run(fixture.input, signal())).toMatchObject({
      status: "review",
      code: "ARTIFACT.INTEGRITY",
    });
    expect(fixture.get).toHaveBeenCalledOnce();
  });
});
