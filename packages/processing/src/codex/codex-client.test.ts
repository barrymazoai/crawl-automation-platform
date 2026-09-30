import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexError,
  CodexRpc,
  fakeCodexServerPath,
  type CodexConnectionOptions,
} from "@crawl-automation/platform";
import { CodexClient } from "./codex-client.js";
import { asVisionCodexError } from "./codex-errors.js";
import type { CodexModelProfile } from "./codex-profile.js";

const signal = () => AbortSignal.timeout(5000);

const profile = (changes: Partial<CodexModelProfile> = {}): CodexModelProfile => ({
  workspace: "execution-",
  modalities: ["text"],
  renameError: (error) => error,
  privateConfig: () => new Error("private config"),
  closed: () => new Error("closed"),
  ...changes,
});

async function openClient(
  scenario: string,
  options: { profile?: CodexModelProfile; effort?: string; model?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "codex-client-"));
  const codexHome = join(root, "home");
  await mkdir(codexHome, { mode: 0o700 });
  const settings = {
    settings: {
      provider: "fixture",
      model: options.model ?? "fixture-model",
      reasoningEffort: options.effort ?? "high",
    },
    executable: process.execPath,
    codexHome,
    workRoot: join(root, "work"),
    runtimeProfileVersion: "fixture/1",
    timeoutMs: 3000,
  };
  const connections: CodexConnectionOptions[] = [];
  const connect = (connection: CodexConnectionOptions) => {
    connections.push(connection);
    return new CodexRpc({
      ...connection,
      executable: process.execPath,
      args: ["--import", "tsx", fakeCodexServerPath, scenario],
      // Resolve the test loader from platform; the thread still receives its isolated workspace.
      cwd: dirname(fakeCodexServerPath),
      env: {},
    });
  };
  const environment = { PATH: "fixture-path", R2_SECRET: "never-passed" };
  const client = await CodexClient.open(settings, {
    environment,
    profile: options.profile ?? profile(),
    connect,
  });
  return { root, settings, client, connections };
}

const call = { prompt: "evidence", outputSchema: { type: "object" } };

describe("shared Codex client", () => {
  it("runs one owned app-server process per call, with retries off, and removes its directory", async () => {
    const opened = await openClient("success");
    expect(await opened.client.run(call, signal())).toContain('"formula"');
    const [connection] = opened.connections;
    expect(connection?.args).toContain("model_providers.fixture.request_max_retries=0");
    expect(connection?.env).not.toHaveProperty("R2_SECRET");
    expect(await readdir(opened.settings.workRoot)).toEqual([]);
    await opened.client.close();
  });

  it("attaches the original image, and checks the model accepts images", async () => {
    const imageProfile = profile({ workspace: "vision-", modalities: ["text", "image"] });
    const opened = await openClient("vision", {
      profile: imageProfile,
      effort: "medium",
      model: "fixture",
    });
    await opened.client.check(signal());
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const answer = await opened.client.run(
      { ...call, image: { name: "source.jpg", bytes } },
      signal(),
    );
    expect(JSON.parse(answer)).toHaveProperty("hash");
    expect(opened.connections).toHaveLength(2);
    await opened.client.close();
  });

  it("a failed turn is never restarted, and the stop is reported", async () => {
    const opened = await openClient("failed-turn");
    let stopped = 0;
    await expect(opened.client.run(call, signal(), () => stopped++)).rejects.toBeInstanceOf(
      CodexError,
    );
    expect([opened.connections.length, stopped]).toEqual([1, 1]);
    await opened.client.close();
  });

  it("names failures the model's way (vision: VISION.*)", async () => {
    const opened = await openClient("failed-turn", {
      profile: profile({ renameError: asVisionCodexError }),
    });
    await expect(opened.client.run(call, signal())).rejects.toMatchObject({
      code: expect.stringMatching(/^VISION\.CODEX_/),
      cause: expect.objectContaining({ code: expect.stringMatching(/^TEXT\.CODEX_/) }),
    });
    await opened.client.close();
  });

  it("the startup check reads capabilities only, and refuses another provider", async () => {
    const opened = await openClient("catalog-provider");
    await expect(opened.client.check(signal())).rejects.toMatchObject({
      code: "TEXT.CODEX_CATALOG_PROVIDER_MISMATCH",
    });
    await opened.client.close();
  });

  it("after close, new calls fail without starting a process", async () => {
    const opened = await openClient("success");
    await opened.client.close();
    await expect(opened.client.run(call, signal())).rejects.toThrow();
    expect(opened.connections).toHaveLength(0);
  });

  it("refuses a Codex home other users can read", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-client-"));
    const codexHome = join(root, "home");
    await mkdir(codexHome, { mode: 0o755 });
    await writeFile(join(root, "marker"), "");
    const settings = {
      settings: { provider: "fixture", model: "m", reasoningEffort: "high" },
      executable: process.execPath,
      codexHome,
      workRoot: join(root, "work"),
      runtimeProfileVersion: "fixture/1",
      timeoutMs: 3000,
    };
    await expect(
      CodexClient.open(settings, { environment: {}, profile: profile() }),
    ).rejects.toMatchObject({
      message: "private config",
      cause: { code: "CONFIG.UNSAFE_DIRECTORY" },
    });
  });

  it("preserves a missing directory as the private-config failure's cause", async () => {
    const opened = await openClient("success");
    const settings = { ...opened.settings, codexHome: join(opened.root, "absent") };
    await expect(
      CodexClient.open(settings, { environment: {}, profile: profile() }),
    ).rejects.toMatchObject({ message: "private config", cause: { code: "ENOENT" } });
    await opened.client.close();
  });
});
