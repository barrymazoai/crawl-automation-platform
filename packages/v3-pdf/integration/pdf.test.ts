import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PdfSubprocess } from "../src/index.js";
import { inputFor, nutritionPdf } from "./helpers.js";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { runProcess } from "../src/process.js";

const python = resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const signal = new AbortController().signal;
let root: string, adapter: PdfSubprocess;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-pdf-"));
  await writeFile(join(root, "nutrition.pdf"), nutritionPdf());
  await promisify(execFile)(python, ["-I", resolve("integration/fixtures/create.py"), root]);
  adapter = await PdfSubprocess.open({ pythonExecutable: python, workRoot: join(root, "attempts") });
  console.log(`PDF evidence: ${root}`);
});
describe("real PDFium subprocess", () => {
  it("inspects pages and keeps identity and local-only completion explicit", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.inspect");
    const result = await adapter.run(input, bytes, signal);
    expect(result.data).toEqual({ kind: "inspect", pageCount: 1, pages: [{ pageIndex: 0, widthPoints: 600, heightPoints: 400 }] });
    expect(result).toMatchObject({ computedLocal: true, artifactDurable: false, resultRegistered: false });
    expect(result.artifact.producer.operationId).toBe(input.operationId);
  });
  it("extracts actual single-page text", async () => {
    const bytes = nutritionPdf();
    const result = await adapter.run(inputFor(bytes, "pdf.text"), bytes, signal);
    expect(result.data?.kind).toBe("text");
    if (result.data?.kind === "text") {
      expect(result.data.hasText).toBe(true);
      expect(result.data.text).toContain("Vitamin C: 100 mg");
      expect(result.data.text).toContain("Ingredients: ascorbic acid, cellulose.");
    }
  });
  it("renders a real page with parent identity and fixed scale", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.render", "render", 0, 2);
    const result = await adapter.run(input, bytes, signal);
    expect(result.artifact).toMatchObject({ kind: "pdf-page", parentArtifactId: input.pdf.artifactId, pageIndex: 0 });
    expect(result.manifest).toMatchObject({ width: 1200, height: 800, scale: 2 });
    await writeFile(join(root, "nutrition.png"), result.bytes);
  });
  it("honors PDF page rotation", async () => {
    const bytes = await readFile(join(root, "rotated.pdf"));
    const result = await adapter.run(inputFor(bytes, "pdf.render"), bytes, signal);
    expect(result.manifest).toMatchObject({ width: 400, height: 600 });
    await writeFile(join(root, "rotated.png"), result.bytes);
  });
  it("empty text is a valid result and does not trigger OCR", async () => {
    const bytes = await readFile(join(root, "blank.pdf"));
    const result = await adapter.run(inputFor(bytes, "pdf.text"), bytes, signal);
    expect(result.data).toEqual({ kind: "text", pageIndex: 0, text: "", hasText: false });
  });
  it.each([["encrypted", "PDF.ENCRYPTED"], ["encrypted-empty", "PDF.ENCRYPTED"], ["many", "PDF.PAGE_LIMIT"], ["huge", "PDF.DIMENSIONS"]])("classifies %s", async (name, code) => {
    const bytes = await readFile(join(root, `${name}.pdf`));
    await expect(adapter.run(inputFor(bytes, "pdf.inspect"), bytes, signal)).rejects.toMatchObject({ code, attemptId: expect.stringMatching(/^pdf-/) });
  });
  it("rejects oversized render before allocating bitmap", async () => {
    const bytes = await readFile(join(root, "pixels.pdf"));
    await expect(adapter.run(inputFor(bytes, "pdf.render"), bytes, signal)).rejects.toMatchObject({ code: "PDF.DIMENSIONS" });
  });
  it("classifies malformed PDF beyond its header", async () => {
    const bytes = Buffer.from("%PDF-1.7\nnot a PDF");
    await expect(adapter.run(inputFor(bytes, "pdf.inspect"), bytes, signal)).rejects.toMatchObject({ code: "PDF.BAD_FILE" });
  });
  it("rejects nonexistent page", async () => {
    const bytes = nutritionPdf();
    await expect(adapter.run(inputFor(bytes, "pdf.text", "range", 1), bytes, signal)).rejects.toMatchObject({ code: "PDF.PAGE_RANGE" });
  });
  it("uses independent processes/attempts for concurrent operations", async () => {
    const bytes = nutritionPdf();
    const results = await Promise.all([0, 1, 2].map(n => adapter.run(inputFor(bytes, "pdf.text", `parallel-${n}`), bytes, signal)));
    expect(new Set(results.map(r => r.manifest.process.pid)).size).toBe(3);
    expect(new Set(results.map(r => r.attemptId)).size).toBe(3);
  });
  it("recovers evidence read-only, with Python unavailable", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.text", "recover");
    const initial = await adapter.run(input, bytes, signal);
    const receiptPath = join(root, "attempts", initial.attemptId, "complete.json");
    const before = await stat(receiptPath);
    const offline = await PdfSubprocess.open({ pythonExecutable: join(root, "python-does-not-exist"), workRoot: join(root, "attempts") });
    const restored = await offline.inspectAttempt(input, initial.attemptId, signal);
    expect(restored).toEqual(initial);
    expect((await stat(receiptPath)).mtimeMs).toBe(before.mtimeMs);
  });
  it("rejects tampered output without recomputing", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.text", "tamper");
    const result = await adapter.run(input, bytes, signal);
    await writeFile(join(root, "attempts", result.attemptId, "output.json"), "{}");
    await expect(adapter.inspectAttempt(input, result.attemptId, signal)).rejects.toMatchObject({ code: "PDF.RESULT_INTEGRITY" });
  });
  it("rejects completion belonging to another operation", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.text", "identity");
    const result = await adapter.run(input, bytes, signal);
    await expect(adapter.inspectAttempt(inputFor(bytes, "pdf.text", "other"), result.attemptId, signal)).rejects.toMatchObject({ code: "PDF.RESULT_INTEGRITY" });
  });
  it("missing completion stays unproven", async () => {
    const bytes = Buffer.from("%PDF-1.7\nbroken"), input = inputFor(bytes, "pdf.text", "incomplete");
    let attemptId = "";
    try { await adapter.run(input, bytes, signal); } catch (error) { attemptId = (error as { attemptId: string }).attemptId; }
    await expect(adapter.inspectAttempt(input, attemptId, signal)).rejects.toMatchObject({ code: "PDF.ATTEMPT_MISSING" });
  });
  it("recovers after actual SIGKILL following the real Python completion write", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.text", "hard-interruption");
    const dir = await mkdtemp(join(root, "attempts", "pdf-"));
    await writeFile(join(dir, "source.pdf"), bytes);
    await writeFile(join(dir, "input.json"), JSON.stringify(input));
    await expect(runProcess({ executable: python,
      args: ["-I", resolve("integration/fixtures/process.py"), "after-complete", resolve("python/worker.py")], cwd: dir,
      stdin: JSON.stringify(input), timeoutMs: 5000, signal })).rejects.toMatchObject({ code: "PDF.PROCESS_FAILED" });
    const restored = await adapter.inspectAttempt(input, basename(dir), signal);
    expect(restored.data?.kind === "text" && restored.data.text.includes("Vitamin C")).toBe(true);
  });
  it("rejects a forged page binding even if output bytes are intact", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.render", "binding");
    const result = await adapter.run(input, bytes, signal);
    await writeFile(join(root, "attempts", result.attemptId, "complete.json"), JSON.stringify({ ...result.manifest, pageIndex: 1 }));
    await expect(adapter.inspectAttempt(input, result.attemptId, signal)).rejects.toMatchObject({ code: "PDF.RESULT_INTEGRITY" });
  });
  it("rejects a source changed after completion", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.text", "source-tamper");
    const result = await adapter.run(input, bytes, signal);
    await writeFile(join(root, "attempts", result.attemptId, "source.pdf"), Buffer.from("%PDF-1.7 wrong source"));
    await expect(adapter.inspectAttempt(input, result.attemptId, signal)).rejects.toMatchObject({ code: "PDF.RESULT_INTEGRITY" });
  });
  it("rejects attempts redirected by symlink", async () => {
    const bytes = nutritionPdf(), input = inputFor(bytes, "pdf.text", "symlink");
    const result = await adapter.run(input, bytes, signal);
    await symlink(join(root, "attempts", result.attemptId), join(root, "attempts", "pdf-sym001"), "junction");
    await expect(adapter.inspectAttempt(input, "pdf-sym001", signal)).rejects.toMatchObject({ code: "PDF.RESULT_INTEGRITY" });
  });
  it("runs public W3C PDF through the built Node entry, not only TS source", async () => {
    const path = process.env.V3_PDF_PUBLIC_SAMPLE;
    if (!path) throw Error("Set V3_PDF_PUBLIC_SAMPLE to the downloaded W3C dummy.pdf; this test is not silently skipped");
    const bytes = await readFile(path);
    expect(sha256(bytes)).toBe("3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4");
    const input = inputFor(bytes, "pdf.text", "w3c");
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
      `import {PdfSubprocess} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
       import {readFile,writeFile} from 'node:fs/promises';
       const adapter=await PdfSubprocess.open(${JSON.stringify({ pythonExecutable: python, workRoot: join(root, "built-attempts") })});
       const bytes=await readFile(${JSON.stringify(path)});
       const r=await adapter.run(${JSON.stringify(input)},bytes,new AbortController().signal);
       const page=await adapter.run(${JSON.stringify(inputFor(bytes, "pdf.render", "w3c-render"))},bytes,new AbortController().signal);
       await writeFile(${JSON.stringify(join(root, "w3c.png"))},page.bytes);
       console.log(JSON.stringify({data:r.data,manifest:page.manifest}));`]);
    const report = JSON.parse(stdout);
    expect(report.data.text).toBe("Dummy PDF file");
    expect(report.manifest).toMatchObject({ width: 595, height: 842 });
  });
});
