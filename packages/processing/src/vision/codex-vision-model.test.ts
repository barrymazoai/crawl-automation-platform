import { describe, expect, it } from "vitest";
import { CodexTextModel } from "../text/model/codex-text-model.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRpc, type CodexConnectionOptions } from "@crawl-automation/v3-codex";
import { image, JPEG, labelAnswer } from "../testing/vision-fixture.js";
import { CodexVisionModel } from "./codex-vision-model.js";

const base = {
  settings: { provider: "openai", model: "gpt-5.5", reasoningEffort: "high" },
  executable: "/usr/bin/codex",
  codexHome: "/tmp/h",
  workRoot: "/tmp/w",
  runtimeProfileVersion: "codex-profile/1",
  timeoutMs: 240_000,
};

// Fingerprints the previous clients computed for the same settings (v3-vision CodexVisionProvider, and the text
// model before its move onto the shared client): existing tasks and results must stay valid.
describe("model setup fingerprints", () => {
  it.each([
    [undefined, "0dedb0376d04695383493ec1a14380935fe1edcc0d5e8d8530245cb060ec01c5"],
    ["label-extraction/1", "440b56ce34232843f63c1d24cae548bedc4d748a97c1a13617ee121128c5cf2c"],
    ["label-extraction/2", "3f3d9ebdde78f670a954d31b7b349a07903e87335a6b940b6f1b17e2e2a4f4fb"],
  ] as const)("vision %s is unchanged", (extractionProtocol, fingerprint) => {
    const config = extractionProtocol ? { ...base, extractionProtocol } : base;
    expect(CodexVisionModel.describe(config).configFingerprint).toBe(fingerprint);
  });

  it.each([
    [undefined, "2573146e2a3aeee817a7663cd465ddb3b42258ec5debe8923c39c64cdc7a071e"],
    ["label-extraction/1", "49c56e62cc5c8c7f4fefcc534af3b29b410b5f84e25fcf7a095584b8b93a1c54"],
  ] as const)("text %s is unchanged", (extractionProtocol, fingerprint) => {
    const config = extractionProtocol ? { ...base, extractionProtocol } : base;
    expect(CodexTextModel.describe(config).configFingerprint).toBe(fingerprint);
  });
});

describe("vision model", () => {
  const imageServer = fileURLToPath(
    new URL("../../../v3-vision/src/codex.fixture.mjs", import.meta.url),
  );

  async function openModel(args: string[], extractionProtocol?: "label-extraction/1") {
    const root = await mkdtemp(join(tmpdir(), "vision-model-"));
    const codexHome = join(root, "home");
    await mkdir(codexHome, { mode: 0o700 });
    const config = {
      settings: { provider: "fixture", model: "fixture", reasoningEffort: "medium" },
      executable: process.execPath,
      codexHome,
      workRoot: join(root, "work"),
      runtimeProfileVersion: "fixture/1",
      timeoutMs: 3000,
      ...(extractionProtocol ? { extractionProtocol } : {}),
    };
    const connect = (options: CodexConnectionOptions) =>
      new CodexRpc({
        ...options,
        executable: process.execPath,
        args: [imageServer, ...args],
        env: {},
      });
    return { model: await CodexVisionModel.open(config, {}, connect) };
  }

  it("sends the label prompt with the original image and returns the model's answer", async () => {
    const candidate = JSON.parse(labelAnswer());
    const response = join(await mkdtemp(join(tmpdir(), "vision-answer-")), "response.json");
    await writeFile(response, JSON.stringify({ imageSha256: image.sha256, candidate }));
    const { model } = await openModel(["label-result", response], "label-extraction/1");
    await model.check(AbortSignal.timeout(5000));
    const answer = await model.interpret(image, JPEG, AbortSignal.timeout(5000));
    expect(JSON.parse(answer)).toEqual(candidate);
    await model.close();
  });

  it("a model that cannot read images fails the startup check (with Codex's own code, as before)", async () => {
    const { model } = await openModel(["text-only"]);
    await expect(model.check(AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "TEXT.CODEX_IMAGE_UNSUPPORTED",
    });
    await model.close();
  });

  it("refuses bytes that are not the referenced image before any call", async () => {
    const { model } = await openModel([]);
    await expect(
      model.interpret(image, Buffer.from("other"), AbortSignal.timeout(5000)),
    ).rejects.toThrow();
    await model.close();
  });
});
