#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const [jobDirectoryArg, ordinalArg, itemCountArg, stagingDirectoryArg] = process.argv.slice(2);
if (!jobDirectoryArg || ordinalArg === undefined || itemCountArg === undefined || !stagingDirectoryArg) {
  throw new Error("用法：publish-capture-batch.mjs <job-directory> <ordinal> <item-count> <staging-directory>");
}

const jobDirectory = path.resolve(jobDirectoryArg);
const stagingRoot = path.join(jobDirectory, "staging");
const stagingDirectory = path.resolve(stagingDirectoryArg);
const ordinal = Number.parseInt(ordinalArg, 10);
const itemCount = Number.parseInt(itemCountArg, 10);
if (!Number.isInteger(ordinal) || ordinal < 0 || !Number.isInteger(itemCount) || itemCount < 0) {
  throw new Error("ordinal 和 item-count 必须是非负整数");
}
if (!stagingDirectory.startsWith(`${stagingRoot}${path.sep}`)) {
  throw new Error("staging-directory 必须位于任务目录的 staging/ 下");
}

const handoffRoot = path.join(jobDirectory, "handoff");
const batchName = `evidence-${String(ordinal).padStart(6, "0")}`;
const evidenceDirectory = path.join(handoffRoot, batchName);
const descriptor = path.join(handoffRoot, `${batchName}.ready.json`);
await fs.mkdir(handoffRoot, { recursive: true });
if (await fs.stat(evidenceDirectory).catch(() => null) || await fs.stat(descriptor).catch(() => null)) {
  throw new Error(`批次 ${ordinal} 已发布，禁止覆盖不可变产物`);
}

await fs.rename(stagingDirectory, evidenceDirectory);
const temporaryDescriptor = `${descriptor}.${process.pid}.tmp`;
await fs.writeFile(temporaryDescriptor, `${JSON.stringify({
  ordinal,
  itemCount,
  evidenceDirectory: path.relative(jobDirectory, evidenceDirectory),
}, null, 2)}\n`);
await fs.rename(temporaryDescriptor, descriptor);
process.stdout.write(`${descriptor}\n`);
