import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { pageText } from "@crawl-automation/channels-core";
import { parseSwansonStaticHtml, SWANSON_ORIGIN } from "@crawl-automation/channel-swanson";
import { describe, expect, it } from "vitest";
import { parseSwansonStaticHtml as oldReader } from "../index.js";

const capturedAt = "2026-09-28T23:45:00.000Z";
const fixtures = [
  {
    file: "healthy-origins-d-ribose.html.gz",
    path: "/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  },
  {
    file: "healthy-origins-ubiquinol-variant.html.gz",
    path: "/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels?variant=46318812168330",
  },
];

describe("the Swanson-owned static reader matches the previous adapter's reader", () => {
  it.each(fixtures)("preserves the entire projection of $file", ({ file, path }) => {
    const fixture = new URL(`../../../channels/swanson/src/fixtures/${file}`, import.meta.url);
    const html = gunzipSync(readFileSync(fixture)).toString("utf8");
    const url = `${SWANSON_ORIGIN}${path}`;
    const previous = oldReader(html, url, capturedAt, (element) => pageText(element.innerHTML));
    expect(parseSwansonStaticHtml(html, url, capturedAt)).toStrictEqual(previous);
  });
});
