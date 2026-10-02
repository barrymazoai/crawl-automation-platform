import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexClient } from "../codex/codex-client.js";
import { image, JPEG } from "../testing/vision-fixture.js";
import { CodexVisionConfigSchema, CodexVisionModel } from "./codex-vision-model.js";
import { decodeVisionResult } from "./protocol/vision-protocol.js";
import { imageSource } from "../testing/label-sources.js";
import { explicitNoneWire } from "./protocol/ingredient-presence-fixture.js";

const config = {
  settings: { provider: "openai", model: "gpt-5.5", reasoningEffort: "high" },
  executable: process.execPath,
  codexHome: "/tmp/vision-home",
  workRoot: "/tmp/vision-work",
  runtimeProfileVersion: "codex-profile/1",
  timeoutMs: 240_000,
  extractionProtocol: "label-extraction/1" as const,
  visualProtocol: "label-visual-wire/3" as const,
};

afterEach(() => vi.restoreAllMocks());

describe("versioned visual ingredient-presence setup", () => {
  it("fingerprints the new protocol and the default-on policy independently of historical setups", () => {
    const current = CodexVisionModel.describe(config);
    const on = CodexVisionModel.describe({
      ...config,
      ingredientPresencePolicy: { allowNoOtherIngredientsSection: true },
    });
    const off = CodexVisionModel.describe({
      ...config,
      ingredientPresencePolicy: { allowNoOtherIngredientsSection: false },
    });
    const { visualProtocol: _wire, ...old } = config;
    expect(current).toEqual(on);
    expect(current.configFingerprint).not.toBe(off.configFingerprint);
    expect(current.configFingerprint).not.toBe(CodexVisionModel.describe(old).configFingerprint);
    expect(
      CodexVisionConfigSchema.safeParse({ ...config, extractionProtocol: undefined }).success,
    ).toBe(false);
  });

  it.each([true, false])(
    "makes one call, preserving raw output and caller policy (%s) for recheck",
    async (allow) => {
      const root = await mkdtemp(join(tmpdir(), "ingredient-model-"));
      const codexHome = join(root, "home");
      await mkdir(codexHome, { mode: 0o700 });
      const raw = ` ${JSON.stringify(explicitNoneWire())}\n`;
      const run = vi.spyOn(CodexClient.prototype, "run").mockResolvedValue(raw);
      const model = await CodexVisionModel.open(
        {
          ...config,
          codexHome,
          workRoot: join(root, "work"),
          ingredientPresencePolicy: { allowNoOtherIngredientsSection: allow },
        },
        {},
      );
      try {
        const answer = await model.interpret(image, JPEG, new AbortController().signal);
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0].outputSchema).toMatchObject({
          properties: { codec: { const: "label-visual-wire/3" } },
        });
        expect(JSON.parse(answer)).toMatchObject({
          raw,
          policy: { allowNoOtherIngredientsSection: allow },
        });
        const { source } = imageSource(explicitNoneWire().label, 0);
        expect(decodeVisionResult(source.task.input, answer).status).toBe(
          allow ? "candidate" : "review",
        );
      } finally {
        await model.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
