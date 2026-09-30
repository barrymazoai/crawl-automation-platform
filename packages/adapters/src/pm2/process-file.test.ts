import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ecosystem, readEcosystem } from "./ecosystem.js";
import { requireManualDaemon } from "./pm2-client.js";
import { Pm2ProcessFile } from "./process-file.js";
import { exampleJob } from "./testing.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "crawler-pm2-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const options = () => ({
  file: join(directory, "ecosystem.json"),
  backups: join(directory, "backups"),
});

describe("PM2 ecosystem file", () => {
  it("writes explicit executable, arguments, environment, logs and no automatic restart/startup", async () => {
    const store = new Pm2ProcessFile(options());
    expect(await store.read()).toEqual([]);
    expect(await store.replace([exampleJob(), exampleJob("vision-worker")])).toEqual({
      backup: null,
    });
    const bytes = await readFile(options().file, "utf8");
    const file = JSON.parse(bytes);
    expect(file.apps[0]).toMatchObject({
      name: "pipeline-worker",
      script: exampleJob().script,
      args: ["--label", "two words"],
      cwd: "/release",
      interpreter: "/opt/node",
      env: exampleJob().env,
      out_file: exampleJob().outFile,
      error_file: exampleJob().errorFile,
    });
    expect(
      file.apps.every(
        (app: { autorestart: boolean; watch: boolean }) =>
          app.autorestart === false && app.watch === false,
      ),
    ).toBe(true);
    expect(bytes).not.toMatch(/startup|save|cron_restart|max_memory_restart/);
    expect((await stat(options().file)).mode & 0o777).toBe(0o600);
    expect(readEcosystem(bytes)).toEqual([exampleJob(), exampleJob("vision-worker")]);
  });

  it("backs up the exact previous bytes privately before replacing", async () => {
    const bytes = ` \n${JSON.stringify(ecosystem([exampleJob()]))}\n\n`;
    await writeFile(options().file, bytes);
    const store = new Pm2ProcessFile(options());
    await store.read();
    const receipt = await store.replace([exampleJob("replacement")]);
    expect(receipt.backup).not.toBeNull();
    expect(await readFile(receipt.backup ?? "", "utf8")).toBe(bytes);
    expect((await stat(receipt.backup ?? "")).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual([exampleJob("replacement")]);
  });

  it("refuses a concurrent process-file change", async () => {
    const store = new Pm2ProcessFile(options());
    await store.read();
    await writeFile(options().file, "concurrent update");
    await expect(store.replace([exampleJob()])).rejects.toMatchObject({ code: "PM2.FILE_CHANGED" });
    expect(await readFile(options().file, "utf8")).toBe("concurrent update");
  });

  it.each([
    "broken",
    JSON.stringify({ jobs: [] }),
    JSON.stringify({ apps: [{ autorestart: true }] }),
  ])("refuses invalid or legacy process files without replacing them", async (bytes) => {
    await writeFile(options().file, bytes);
    const store = new Pm2ProcessFile(options());
    await expect(store.read()).rejects.toMatchObject({ code: "PM2.FILE_INVALID" });
    expect(await readFile(options().file, "utf8")).toBe(bytes);
  });

  it("leaves the previous file intact if backup fails", async () => {
    const bytes = JSON.stringify(ecosystem([exampleJob()]));
    await writeFile(options().file, bytes);
    await writeFile(options().backups, "not a directory");
    const store = new Pm2ProcessFile(options());
    await store.read();
    await expect(store.replace([])).rejects.toMatchObject({
      code: "PM2.FILE_WRITE_FAILED",
      details: { backup: null },
    });
    expect(await readFile(options().file, "utf8")).toBe(bytes);
  });

  it("requires an explicit, already running PM2 home; never boots a daemon for a deploy", async () => {
    await expect(requireManualDaemon(undefined)).rejects.toMatchObject({
      code: "PM2.DAEMON_REQUIRED",
    });
    await expect(requireManualDaemon(directory)).rejects.toMatchObject({
      code: "PM2.DAEMON_REQUIRED",
    });
    await writeFile(join(directory, "pm2.pid"), String(process.pid));
    await expect(requireManualDaemon(directory)).rejects.toMatchObject({
      code: "PM2.DAEMON_REQUIRED",
    });
  });
});
