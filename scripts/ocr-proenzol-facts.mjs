import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const evidenceDir = process.argv[2]
  ?? new URL(
    "../real-crawl-results/company-ingredients-20260817-repaired/evidence/proenzol-facts/",
    import.meta.url,
  ).pathname;
const captureManifestPath = `${evidenceDir.replace(/\/$/, "")}/capture-manifest.json`;
const ocrManifestPath = `${evidenceDir.replace(/\/$/, "")}/ocr-manifest.json`;

const captures = JSON.parse(await readFile(captureManifestPath, "utf8"));
const results = [];

for (const capture of captures) {
  if (capture.captureStatus !== "complete" || !capture.file) {
    results.push({
      ...capture,
      ocrStatus: "skipped",
      ocrError: "browser_capture_incomplete",
    });
    continue;
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "tesseract",
      [capture.file, "stdout", "--psm", "6"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    results.push({
      ...capture,
      ocrStatus: "complete",
      ocrText: stdout.trim(),
      ocrWarnings: stderr.trim(),
    });
  } catch (error) {
    results.push({
      ...capture,
      ocrStatus: "failed",
      ocrError: error instanceof Error ? error.message : String(error),
    });
  }
}

await writeFile(ocrManifestPath, `${JSON.stringify(results, null, 2)}\n`);

const completed = results.filter((result) => result.ocrStatus === "complete").length;
const empty = results.filter(
  (result) => result.ocrStatus === "complete" && !result.ocrText,
).length;
const failed = results.length - completed;

console.log(JSON.stringify({
  records: results.length,
  completed,
  empty,
  failed,
  output: ocrManifestPath,
}, null, 2));
