import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { FetchedPage } from "@crawl-automation/channels-core";

const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
const external = process.env["V3_TEST_DATA_DIR"];
const fixtureDirectory = "packages/v3-channels/src/fixtures";
const evidenceDirectory = "docs/quality/evidence/2026-09-23-amazon-html-loading";

export const savedPaths = {
  fish: `${fixtureDirectory}/amazon-static-B0013LAQS6.html.gz`,
  collagen: `${fixtureDirectory}/amazon-static-B0G963NB8Q.html.gz`,
  fishLater: `${evidenceDirectory}/B0013LAQS6.html`,
  manganese: `${evidenceDirectory}/B0D1LQLV1P.html`,
  vitamin: `${evidenceDirectory}/B0GHZDFNP8.html`,
};

/**
 * R45 will relocate data. An explicit override accepts flat files or the same repository-relative
 * layout.
 */
export function savedPage(relative: string) {
  const candidates = external
    ? [join(external, basename(relative)), join(external, relative)]
    : [join(repository, relative)];
  const path = candidates.find(existsSync);
  const asin = basename(relative).match(/B[A-Z0-9]{9}/)?.[0] ?? "";
  const name = path
    ? basename(relative)
    : `SKIPPED: missing ${basename(relative)}; set V3_TEST_DATA_DIR (saved data stays outside git)`;
  return {
    available: Boolean(path),
    name,
    asin,
    read(): FetchedPage {
      if (!path) {
        throw new Error(name);
      }
      const bytes = readFileSync(path);
      return {
        url: `https://www.amazon.com/dp/${asin}`,
        html: (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"),
        capturedAt: "2026-09-23T02:54:24.345Z",
      };
    },
  };
}
