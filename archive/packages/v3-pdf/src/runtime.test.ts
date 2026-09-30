import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { PdfSubprocess, fingerprintPdfInput } from "./index.js";
import { inputFor, nutritionPdf } from "../integration/helpers.js";

let root: string, adapter: PdfSubprocess;
const bytes = nutritionPdf(), signal = new AbortController().signal;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pdf-guards-"));
  adapter = await PdfSubprocess.open({ pythonExecutable: join(root, "not-installed"), workRoot: root });
});
it("rejects relative deployment paths", async () => {
  await expect(PdfSubprocess.open({ pythonExecutable: "python", workRoot: root })).rejects.toMatchObject({ code: "PDF.INVALID_INPUT" });
});
it("rejects mutable input fingerprint before spawning", async () => {
  const i = inputFor(bytes, "pdf.text");
  i.operationId = "changed";
  await expect(adapter.run(i, bytes, signal)).rejects.toMatchObject({ code: "PDF.INVALID_INPUT" });
});
it("rejects owner mismatch", async () => {
  const i = inputFor(bytes, "pdf.text");
  i.pdf.listingId = "other";
  i.inputFingerprint = fingerprintPdfInput(i);
  await expect(adapter.run(i, bytes, signal)).rejects.toMatchObject({ code: "PDF.INVALID_INPUT" });
});
it("rejects unsupported engine configuration", async () => {
  const i = inputFor(bytes, "pdf.text");
  i.configFingerprint = "0".repeat(64);
  await expect(adapter.run(i, bytes, signal)).rejects.toMatchObject({ code: "PDF.ENGINE_MISMATCH" });
});
it("rejects source hash/length mismatch", async () => {
  await expect(adapter.run(inputFor(bytes, "pdf.text"), Buffer.from("%PDF-1.7 other"), signal)).rejects.toMatchObject({ code: "PDF.INPUT_INTEGRITY" });
});
it("rejects source size over the policy", async () => {
  const i = inputFor(bytes, "pdf.text");
  i.pdf.byteSize = 33554433;
  i.inputFingerprint = fingerprintPdfInput(i);
  await expect(adapter.run(i, bytes, signal)).rejects.toMatchObject({ code: "PDF.INPUT_INTEGRITY" });
});
it.each([{ pageIndex: -1 }, { pageIndex: 500 }, { scale: 5 }, { scale: 0 }, { pageIndex: 0.5 }, { url: "https://example.com" }, { command: "python" }])("rejects extra fields/range %j", async fields => {
  await expect(adapter.run({ ...inputFor(bytes, "pdf.render"), ...fields }, bytes, signal)).rejects.toMatchObject({ code: "PDF.INVALID_INPUT" });
});
it("does not create evidence on pre-cancelled operations", async () => {
  const before = await readdir(root), controller = new AbortController();
  controller.abort();
  await expect(adapter.run(inputFor(bytes, "pdf.text"), bytes, controller.signal)).rejects.toMatchObject({ code: "PDF.CANCELLED" });
  expect(await readdir(root)).toEqual(before);
});
it("rejects attempt traversal", async () => {
  await expect(adapter.inspectAttempt(inputFor(bytes, "pdf.text"), "../source", signal)).rejects.toMatchObject({ code: "PDF.INVALID_INPUT" });
});
