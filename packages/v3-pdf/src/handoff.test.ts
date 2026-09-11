import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { FileCopies } from "@crawl-automation/v3-artifacts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { MemoryReviews } from "../../v3-ocr/src/testing.fixture.js";
import { inputFor, nutritionPdf } from "../integration/helpers.js";
import { PdfSubprocess } from "./runtime.js";
import { PdfModule, pdfCompletionKey, pdfAttemptKey } from "./handoff.js";
const signal = () => AbortSignal.timeout(10000);
async function setup(module: "pdf.inspect" | "pdf.render" | "pdf.text" = "pdf.render") {
  const root = await mkdtemp(join(tmpdir(), "v3-pdf-handoff-")), source = nutritionPdf(), input = inputFor(source, module);
  const remote = new MemoryObjects(), journal = new MemoryObjects(), reviews = new MemoryReviews(); remote.data.set(input.pdf.objectKey, source);
  const engine = await PdfSubprocess.open({ pythonExecutable: resolve(".venv/bin/python"), workRoot: join(root, "attempts") });
  const run = vi.spyOn(engine, "run"), deps = { remote, journal, reviews, copies: await FileCopies.open(join(root, "cache")) };
  return { root, source, input, deps, run, engine, module: new PdfModule(deps, engine) };
}
it.each(["pdf.inspect", "pdf.text", "pdf.render"] as const)("%s publishes real PDFium output then replays on a node without Python", async operation => {
  const f = await setup(operation), result = await f.module.run(f.input, signal());
  expect(result.status).toBe("durable");
  const writes = f.deps.remote.writes, disabled = { run: vi.fn().mockRejectedValue(Error("must not execute")) };
  const other = new PdfModule({ ...f.deps, journal: new MemoryObjects(), copies: await FileCopies.open(join(f.root, "other-cache")) }, disabled);
  expect(await other.run(f.input, signal())).toEqual(result); expect(disabled.run).not.toHaveBeenCalled(); expect(f.deps.remote.writes).toBe(writes);
  expect(f.run).toHaveBeenCalledOnce();
  const index = JSON.parse(Buffer.from(f.deps.journal.data.get(pdfAttemptKey(f.input))!).toString());
  expect(index.input).toEqual(f.input); expect(index.attemptId).toMatch(/^pdf-/);
  expect(await readFile(join(f.root, "attempts", index.attemptId, "complete.json"))).not.toHaveLength(0);
});
it("same operation concurrently delivered to two consumers executes Python once", async () => {
  const f = await setup(), outcomes = await Promise.all([f.module.run(f.input, signal()), f.module.run(f.input, signal())]);
  expect(outcomes.some(o => o.status === "durable")).toBe(true); expect(f.run).toHaveBeenCalledOnce();
});
it("unknown intent create cannot authorize Python", async () => {
  const f = await setup(); f.deps.remote.unknown = true;
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "PDF.INTENT_UNKNOWN" });
  expect(f.run).not.toHaveBeenCalled();
});
it("lost completion PUT response reconciles without another execution", async () => {
  const f = await setup(), create = f.deps.remote.create.bind(f.deps.remote);
  vi.spyOn(f.deps.remote, "create").mockImplementation(async (key, bytes) => { const r = await create(key, bytes); if (key === pdfCompletionKey(f.input)) throw Error("lost ack"); return r; });
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "durable" }); expect(f.run).toHaveBeenCalledOnce();
});
it("failed publication preserves attempt and candidate, redelivery does not re-render or upload output", async () => {
  const f = await setup(), create = f.deps.remote.create.bind(f.deps.remote);
  const upload = vi.spyOn(f.deps.remote, "create").mockImplementation(async (key, bytes) => { if (key.endsWith("output.png")) throw Error("offline"); return create(key, bytes); });
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review" });
  const review = [...f.deps.reviews.records.values()][0]!;
  expect(review.candidate).not.toBeNull();
  const attempts = await readdir(join(f.root, "attempts")); expect(attempts).toHaveLength(1);
  expect(await readFile(join(f.root, "attempts", attempts[0]!, "output.png"))).not.toHaveLength(0);
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "PDF.EXECUTION_UNKNOWN" });
  expect(f.run).toHaveBeenCalledOnce(); expect(upload.mock.calls.filter(([key]) => key.endsWith("output.png"))).toHaveLength(1);
});
it("attempt journal failure prevents starting Python and preserves source", async () => {
  const f = await setup(); vi.spyOn(f.deps.journal, "create").mockImplementation(async (key, bytes) => {
    if (key.startsWith("pdf-attempts/")) throw Error("journal offline");
    f.deps.journal.data.set(key, bytes); return "created";
  });
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review" });
  const [id] = await readdir(join(f.root, "attempts"));
  expect(await readFile(join(f.root, "attempts", id!, "source.pdf"))).toEqual(f.source);
  await expect(readFile(join(f.root, "attempts", id!, "complete.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("bad page is classified and no redelivery starts another Python attempt", async () => {
  const f = await setup(); f.input = inputFor(f.source, "pdf.render", "bad-page", 4);
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "PDF.PAGE_RANGE" });
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "PDF.EXECUTION_UNKNOWN" }); expect(f.run).toHaveBeenCalledOnce();
});
it("wrong policy, corrupt original or output cannot execute or be accepted as durable", async () => {
  const f = await setup();
  await expect(f.module.run({ ...f.input, configFingerprint: "0".repeat(64) }, signal())).rejects.toMatchObject({ code: "PDF.ENGINE_MISMATCH" });
  expect(f.run).not.toHaveBeenCalled();
  const r = await f.module.run(f.input, signal()); if (r.status !== "durable") throw Error();
  f.deps.remote.data.set(r.artifact.objectKey, Buffer.from("corrupt"));
  expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review" }); expect(f.run).toHaveBeenCalledOnce();
  f.deps.remote.data.set(f.input.pdf.objectKey, Buffer.from("bad source"));
  await expect(f.module.inspect(f.input, signal())).rejects.toThrow();
});
it("Review database outage is not acknowledged and local evidence remains", async () => {
  const f = await setup(); f.deps.reviews.unavailable = true; f.deps.remote.unknown = true;
  await expect(f.module.run(f.input, signal())).rejects.toThrow();
  expect([...f.deps.journal.data.keys()].some(k => k.startsWith("pdf-reviews/"))).toBe(true); expect(f.run).not.toHaveBeenCalled();
});
it("shared completion rejects changed page, parent, operation or engine even when result bytes still match", async () => {
  const f = await setup(); expect(await f.module.run(f.input, signal())).toMatchObject({ status: "durable" });
  const key = pdfCompletionKey(f.input), original = JSON.parse(Buffer.from(f.deps.remote.data.get(key)!).toString());
  const changes = [
    { ...original, artifact: { ...original.artifact, parentArtifactId: "foreign-pdf" } },
    { ...original, artifact: { ...original.artifact, pageIndex: 1 } },
    { ...original, manifest: { ...original.manifest, operationId: "foreign-operation" } },
    { ...original, manifest: { ...original.manifest, engine: { ...original.manifest.engine, pdfium: "different" } } },
  ];
  for (const changed of changes) {
    f.deps.remote.data.set(key, Buffer.from(JSON.stringify(changed)));
    await expect(f.module.inspect(f.input, signal())).rejects.toThrow();
  }
  expect(f.run).toHaveBeenCalledOnce();
});
