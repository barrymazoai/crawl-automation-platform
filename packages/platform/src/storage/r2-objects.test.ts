import type { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { R2Objects, type R2ClientPort } from "./r2-objects.js";

const scope = {
  endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  bucket: "bucket",
  prefix: "crawl/acceptance",
  timeoutMs: 1_000,
};

describe("R2Objects.list", () => {
  it("lists a folder page by page with keys inside the scope and bare ETags", async () => {
    const send = vi.fn(async (command: ListObjectsV2Command) =>
      command.input.ContinuationToken
        ? { Contents: [{ Key: "crawl/acceptance/v3/a/two", Size: 2, ETag: '"bb"' }] }
        : {
            IsTruncated: true,
            NextContinuationToken: "next",
            Contents: [{ Key: "crawl/acceptance/v3/a/one", Size: 1, ETag: '"aa"' }],
          },
    );
    const r2 = new R2Objects({ send } as unknown as R2ClientPort, scope);

    const listed = [];
    for await (const object of r2.list("v3/a", new AbortController().signal)) {
      listed.push(object);
    }

    expect(listed).toEqual([
      { key: "v3/a/one", byteSize: 1, etag: "aa" },
      { key: "v3/a/two", byteSize: 2, etag: "bb" },
    ]);
    expect(send.mock.calls.map(([command]) => command.input.Prefix)).toEqual([
      "crawl/acceptance/v3/a/",
      "crawl/acceptance/v3/a/",
    ]);
  });

  it("reports a failed listing without the SDK error", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
    });
    const r2 = new R2Objects({ send } as unknown as R2ClientPort, scope);
    const listing = r2.list("v3/a", new AbortController().signal);

    await expect(listing.next()).rejects.toMatchObject({ code: "ARTIFACT.UNAVAILABLE" });
  });
});
