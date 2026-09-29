import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import { loadConfig } from "./load-config.js";

const Schema = z.strictObject({ port: z.number().int() });
let folder: string;

async function writeConfig(name: string, content: string, mode = 0o600): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code });
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "platform-config-"));
});

describe("loadConfig", () => {
  it("returns the parsed config", async () => {
    const path = await writeConfig("ok.json", '{"port":4188}');

    await expect(loadConfig(Schema, path)).resolves.toEqual({ port: 4188 });
  });

  it("rejects a relative path", async () => {
    await expectCode(loadConfig(Schema, "config.json"), "CONFIG.NOT_ABSOLUTE");
  });

  it("rejects a file other users can read", async () => {
    const path = await writeConfig("shared.json", '{"port":1}', 0o644);

    await expectCode(loadConfig(Schema, path), "CONFIG.UNSAFE_FILE");
  });

  it("refuses to follow a symlink", async () => {
    const target = await writeConfig("target.json", '{"port":1}');
    const link = join(folder, "link.json");
    await symlink(target, link);

    await expect(loadConfig(Schema, link)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("names the fields that do not match the schema", async () => {
    const path = await writeConfig("wrong.json", '{"port":"4188"}');

    await expect(loadConfig(Schema, path)).rejects.toMatchObject({
      code: "CONFIG.INVALID",
      details: { issues: ["port"] },
    });
  });
});
