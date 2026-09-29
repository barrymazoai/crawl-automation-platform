import { access, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import type { DeployPorts } from "./deployment.js";
import { deployErrors } from "./deploy-errors.js";

/** The real machine: commands through execa, files written whole (temporary file, then rename). */
export const machinePorts: DeployPorts = {
  async run(step) {
    const result = await execa(step.command, step.args, {
      ...(step.cwd ? { cwd: step.cwd } : {}),
      ...(step.env ? { env: step.env } : {}),
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw deployErrors.create("DEPLOY.COMMAND_FAILED", {
        details: {
          command: step.title,
          exitCode: result.exitCode ?? null,
          stderr: tail(result.stderr),
        },
      });
    }
    return String(result.stdout);
  },
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  readJson: async (path) => JSON.parse(await readFile(path, "utf8")) as unknown,
  async writeJson(path, value) {
    const temporary = `${path}.writing-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  },
  env: (name) => process.env[name],
  now: () => new Date(),
  sleep: (milliseconds) => sleep(milliseconds),
  print: (line) => process.stdout.write(`${line}\n`),
};

/** The last lines of a command's error output, for the failure report. */
function tail(text: unknown): string {
  return String(text ?? "")
    .split("\n")
    .slice(-20)
    .join("\n");
}
