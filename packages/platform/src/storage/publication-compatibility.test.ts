import { describe, expect, it, vi } from "vitest";
import { RetainedPublication as OldPublication } from "@crawl-automation/v3-artifacts";
import { RetainedPublication } from "./retained-publication.js";
import { evidenceBytes, memoryObjects, testSignal } from "./compatibility-fixture.js";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

type Publication = Pick<RetainedPublication, "publish" | "retain">;
type Factory = (
  local: ReturnType<typeof memoryObjects>,
  remote: ReturnType<typeof memoryObjects>,
) => Publication;
const factories: Factory[] = [
  (local, remote) => new OldPublication(local.store, remote.store),
  (local, remote) => new RetainedPublication(local.store, remote.store),
];
const key = "v3/results/evidence.json";

async function publishScenario(factory: Factory, scenario: string) {
  const local = memoryObjects();
  const remote = memoryObjects();
  const publication = factory(local, remote);
  configureScenario({ local, remote }, scenario);
  let code: unknown = "durable";
  try {
    await publication.publish(key, evidenceBytes, "application/json", testSignal());
  } catch (error) {
    code = (error as { code: string }).code;
  }
  return {
    code,
    local: [...local.objects],
    remote: [...remote.objects],
    localCalls: local.calls,
    remoteCalls: remote.calls,
  };
}

function configureScenario(
  stores: { local: ReturnType<typeof memoryObjects>; remote: ReturnType<typeof memoryObjects> },
  scenario: string,
) {
  const { local, remote } = stores;
  if (scenario === "existing") {
    remote.objects.set(key, evidenceBytes);
  }
  if (scenario === "conflict") {
    remote.objects.set(key, Buffer.alloc(evidenceBytes.length));
  }
  if (scenario === "local-conflict") {
    local.objects.set(key, Buffer.alloc(evidenceBytes.length));
  }
  if (scenario === "lost-receipt") {
    const create = remote.store.create;
    remote.store.create = async (...args) => {
      const result = await create(...args);
      if (args[0] === key) {
        throw new Error("lost receipt");
      }
      return result;
    };
  }
}

describe("retained publication persisted format compatibility", () => {
  it.each(["new", "existing", "conflict", "local-conflict", "lost-receipt"])(
    "%s: byte-identical keys, claim records, payloads and I/O sequence",
    async (scenario) => {
      const [oldResult, newResult] = await Promise.all(
        factories.map((factory) => publishScenario(factory, scenario)),
      );
      expect(newResult).toEqual(oldResult);
      if (scenario === "new" || scenario === "lost-receipt") {
        expect(newResult?.code).toBe("durable");
        expect(
          newResult?.remoteCalls.filter((call) => call[0] === "create" && call[1] === key),
        ).toHaveLength(1);
      }
    },
  );

  it.each(factories)(
    "never retries an uncertain claim, even on a second invocation",
    async (factory) => {
      const local = memoryObjects();
      const remote = memoryObjects();
      const create = remote.store.create;
      remote.store.create = async (...args) => {
        await create(...args);
        throw new Error("lost claim receipt");
      };
      const publication = factory(local, remote);
      for (let i = 0; i < 2; i++) {
        await expect(
          publication.publish(key, evidenceBytes, "application/json", testSignal()),
        ).rejects.toMatchObject({ code: "ARTIFACT.UPLOAD_UNKNOWN" });
      }
      expect(remote.calls.filter((call) => call[0] === "create")).toHaveLength(1);
      expect(remote.objects.has(key)).toBe(false);
      expect(local.objects.get(key)).toEqual(evidenceBytes);
    },
  );
});
