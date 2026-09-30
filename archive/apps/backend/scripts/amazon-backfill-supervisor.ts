import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AmazonBackfillState } from "../src/amazon/backfill-state.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  stateFile: z.string().min(1),
  outputDirectory: z.string().min(1),
  idleMs: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
}).parse({
  stateFile: flag("--state") ?? path.resolve("reports", "amazon-backfill", "state.sqlite"),
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", "amazon-backfill"),
  idleMs: flag("--idle-ms") ?? 5_000,
});
const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

delete process.env.CODEX_API_KEY;
await fsp.mkdir(cli.outputDirectory, { recursive: true });
const pidFile = path.join(cli.outputDirectory, "supervisor.pid");
const oldPid = Number(await fsp.readFile(pidFile, "utf8").catch(() => ""));
if (Number.isInteger(oldPid) && oldPid > 0) {
  try { process.kill(oldPid, 0); throw new Error(`Amazon backfill supervisor 已运行，PID=${oldPid}`); }
  catch (error) { if (error instanceof Error && error.message.includes("已运行")) throw error; }
}
await fsp.writeFile(pidFile, `${process.pid}\n`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exportStatus() {
  const state = new AmazonBackfillState(cli.stateFile);
  try {
    const generatedAt = new Date().toISOString();
    const reviewItems = state.listReviewQueue();
    await fsp.writeFile(path.join(cli.outputDirectory, "queue-status.json"), `${JSON.stringify({
      mode: "product_staging_backfill",
      productStagingWrites: true,
      productRestoreWrites: false,
      generatedAt,
      lanes: state.summary(),
      formula: state.formulaSummary(),
      staging: state.stagingSummary(),
      reviewPending: reviewItems.length,
    }, null, 2)}\n`);
    await fsp.writeFile(path.join(cli.outputDirectory, "needs-review.json"), `${JSON.stringify({ generatedAt, items: reviewItems }, null, 2)}\n`);
  } finally { state.close(); }
}

async function runLane(name: string, script: string, args: string[]) {
  const log = fs.createWriteStream(path.join(cli.outputDirectory, `${name}.log`), { flags: "a" });
  const command = process.env.PNPM_EXECUTABLE ?? "pnpm";
  const child = spawn(command, ["--filter", "@crawl-automation/backend", "exec", "tsx", script, ...args], {
    cwd: repositoryDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => log.end());
  if (code !== 0) throw new Error(`${name} lane 退出码 ${code}`);
  await exportStatus();
}

async function laneLoop(name: string, script: string, args: string[]) {
  while (!stopping) {
    try { await runLane(name, script, args); }
    catch (error) {
      await fsp.appendFile(path.join(cli.outputDirectory, `${name}.supervisor.log`), `${new Date().toISOString()} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    if (!stopping) await sleep(cli.idleMs);
  }
}

await exportStatus();
try {
  await Promise.all([
    laneLoop("text", "scripts/amazon-backfill-dry-run.ts", [
      "--skip-seed", "--limit", "20", "--state", cli.stateFile,
      "--output-dir", path.join(cli.outputDirectory, "text-evidence"),
    ]),
    laneLoop("image", "scripts/amazon-backfill-image-lane.ts", [
      "--limit", "20", "--product-concurrency", "2", "--image-concurrency", "5",
      "--state", cli.stateFile, "--output-dir", cli.outputDirectory,
    ]),
    laneLoop("formula", "scripts/amazon-backfill-formula-dry-run.ts", [
      "--limit", "20", "--concurrency", "10", "--state", cli.stateFile,
      "--output-dir", path.join(cli.outputDirectory, "formula-evidence"),
    ]),
    laneLoop("staging", "scripts/amazon-backfill-staging-lane.ts", [
      "--limit", "20", "--concurrency", "5", "--state", cli.stateFile,
      "--run-id", path.basename(cli.outputDirectory),
    ]),
  ]);
} finally {
  await exportStatus().catch(() => undefined);
  await fsp.rm(pidFile, { force: true });
}
