import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServerRunner } from "../../../packages/runtime/dist/index.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-app-server-smoke-"));
const schemaPath = path.join(directory, "result.schema.json");
const outputPath = path.join(directory, "result.json");
const eventLogPath = path.join(directory, "events.jsonl");
await fs.writeFile(schemaPath, JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", const: "ok" },
    transport: { type: "string", const: "stdio" },
    label: { type: "string" },
  },
  required: ["status", "transport", "label"],
  additionalProperties: false,
}, null, 2));

const runner = new CodexAppServerRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: false,
});

try {
  const threads = new Map();
  const run = (label) => runner.run({
    prompt: `This is local stdio concurrency smoke test ${label}. Return status=ok, transport=stdio, label=${label}. Do not call tools.`,
    cwd: directory, schemaPath,
    outputPath: path.join(directory, `${label}.json`),
    eventLogPath: path.join(directory, `${label}.events.jsonl`),
    threadName: `Local App Server smoke ${label}`,
    onSession: (session) => {
      threads.set(label, session.threadId);
      console.log(`session ${label} ${JSON.stringify(session)}`);
    },
  });
  const results = await Promise.all([run("A"), run("B")]);
  const resumed = await runner.run({
    prompt: "Resume this existing thread. Return status=ok, transport=stdio, label=A-resumed. Do not call tools.",
    cwd: directory, schemaPath,
    outputPath, eventLogPath,
    threadId: threads.get("A"),
    onSession: (session) => console.log(`session A-resumed ${JSON.stringify(session)}`),
  });
  console.log(`parallel-results ${JSON.stringify(results)}`);
  console.log(`resume-result ${JSON.stringify(resumed)}`);
  console.log(`artifacts ${directory}`);
} finally {
  await runner.close();
}
