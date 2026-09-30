import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

/** Test-only reader. R45 will supply these originals from R2; no saved page is checked into this package. */
export function savedDtcData(...paths: string[]): { path: string; text: string } | null {
  const configured = process.env["V3_TEST_DATA_DIR"];
  const candidates = paths.flatMap((path) => [
    ...(configured ? [resolve(configured, path), resolve(configured, basename(path))] : []),
    resolve(process.cwd(), path),
  ]);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    return null;
  }
  const bytes = readFileSync(path);
  return { path, text: (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8") };
}

export const MISSING_DTC_DATA =
  "missing real saved page; set V3_TEST_DATA_DIR (test data stays out of git; R45)";
