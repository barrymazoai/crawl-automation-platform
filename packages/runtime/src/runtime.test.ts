import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRunner, LocalCheckpointStore, buildBrowserCapturePrompt, classifyUrl } from "./index";

function fakeAppServer() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  const methods: string[] = [];
  const requests: any[] = [];
  let threadCounter = 0;
  let turnCounter = 0;

  Object.assign(emitter, {
    stdin, stdout, stderr, exitCode: null,
    kill: vi.fn(() => {
      emitter.exitCode = 0;
      queueMicrotask(() => emitter.emit("exit", 0, null));
      return true;
    }),
  });
  const send = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  readline.createInterface({ input: stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    requests.push(request);
    methods.push(request.method ?? "response");
    if (request.id === undefined) return;
    if (request.method === "initialize") send({ id: request.id, result: { userAgent: "fake" } });
    else if (request.method === "thread/start") {
      threadCounter += 1;
      send({ id: request.id, result: { thread: { id: `thread-${threadCounter}` } } });
    } else if (request.method === "thread/resume") {
      send({ id: request.id, result: { thread: { id: request.params.threadId } } });
    } else if (request.method === "thread/name/set") send({ id: request.id, result: {} });
    else if (request.method === "turn/start") {
      turnCounter += 1;
      const turnId = `turn-${turnCounter}`;
      const threadId = request.params.threadId;
      send({ id: request.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      send({ method: "item/completed", params: {
        threadId, turnId, completedAtMs: Date.now(),
        item: { type: "agentMessage", id: `message-${turnCounter}`, text: JSON.stringify({ status: "complete", sequence: turnCounter }) },
      } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    } else if (request.method === "turn/interrupt") send({ id: request.id, result: {} });
    else send({ id: request.id, result: {} });
  });

  return { child: emitter as unknown as ChildProcessWithoutNullStreams, methods, requests };
}

describe("runtime routing", () => {
  it("routes Amazon to its fixed adapter and DTC to Browser Node", () => {
    expect(classifyUrl("https://www.amazon.com/dp/B000000000")).toMatchObject({ type: "sales_channel", adapter: "amazon" });
    expect(classifyUrl("brand.example/products/a")).toMatchObject({ type: "dtc_browser", adapter: null });
  });

  it("builds a browser prompt without hard-coding a git command", () => {
    const prompt = buildBrowserCapturePrompt({ url: "https://brand.example", runId: "run-1", jobDirectory: "/jobs/run-1", nodeId: "windows-1" });
    expect(prompt).toContain("拉取 crawl-products Skill 的最新代码");
    expect(prompt).not.toMatch(/git\s+pull/);
    expect(prompt).toContain("skuMissing=true");
  });

  it("persists resumable checkpoints in SQLite", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-runtime-"));
    const store = new LocalCheckpointStore(path.join(directory, "state.sqlite"));
    store.save("job-1", "capture", "running", { lastUploadedOrdinal: 3 }, "lease");
    expect(store.get("job-1")?.payload).toEqual({ lastUploadedOrdinal: 3 });
    store.saveCodexSession("job-1", "thread-1", "turn-1");
    expect(store.getCodexSession("job-1")).toMatchObject({ threadId: "thread-1", turnId: "turn-1", runner: "app-server" });
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("runs and resumes structured App Server turns over stdio", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-app-server-"));
    const schemaPath = path.join(directory, "result.schema.json");
    await fs.writeFile(schemaPath, JSON.stringify({ type: "object", properties: { status: { type: "string" }, sequence: { type: "number" } }, required: ["status", "sequence"] }));
    const fake = fakeAppServer();
    const runner = new CodexAppServerRunner({ processFactory: () => fake.child, requestTimeoutMs: 1_000 });
    const sessions: Array<{ threadId: string; turnId?: string }> = [];

    const first = await runner.run({
      prompt: "Run the first task", cwd: directory, schemaPath,
      outputPath: path.join(directory, "first.json"), eventLogPath: path.join(directory, "first.events.jsonl"),
      threadName: "First crawl", skill: { name: "crawl-products", path: schemaPath },
      onSession: (session) => sessions.push(session),
    });
    const second = await runner.run({
      prompt: "Resume the task", cwd: directory, schemaPath,
      outputPath: path.join(directory, "second.json"), eventLogPath: path.join(directory, "second.events.jsonl"),
      threadId: "thread-1",
    });

    expect(first).toEqual({ status: "complete", sequence: 1 });
    expect(second).toEqual({ status: "complete", sequence: 2 });
    expect(sessions).toContainEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(fake.methods).toEqual(expect.arrayContaining([
      "initialize", "initialized", "skills/extraRoots/set", "skills/list", "thread/start", "turn/start", "thread/resume",
    ]));
    const firstTurn = fake.requests.find((request) => request.method === "turn/start");
    expect(firstTurn.params.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Run the first task" }),
      expect.objectContaining({ type: "skill", name: "crawl-products", path: schemaPath }),
    ]));
    expect(firstTurn.params.input[0].text).not.toContain("$crawl-products");
    expect(await fs.readFile(path.join(directory, "first.events.jsonl"), "utf8")).toContain("turn/completed");
    await runner.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
