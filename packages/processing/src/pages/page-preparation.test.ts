import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/platform";
import { TextDocumentSchema, parseTextInput } from "@crawl-automation/v3-contracts";
import { decodeJson, hashString } from "../results/result-record.js";
import { defined } from "../testing/defined.js";
import { pageSetup, replacementPageSteps, signedPage } from "../testing/page-fixture.js";
import { pageCompletionKey } from "./page-input.js";

const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

/** Makes one kind of R2 write fail (or lose its acknowledgement) while counting those writes. */
function failWrites(
  setup: ReturnType<typeof pageSetup>,
  matches: (key: string) => boolean,
  stored = false,
) {
  const create = setup.remote.create.bind(setup.remote);
  const counter = { writes: 0 };
  vi.spyOn(setup.remote, "create").mockImplementation(async (key, bytes) => {
    if (!matches(key)) {
      return create(key, bytes);
    }
    counter.writes++;
    if (stored) {
      await create(key, bytes);
    }
    throw new Error("synthetic unavailable");
  });
  return counter;
}

// Cases carried over from the former page handoff.
describe("page preparation and page text", () => {
  it("publishes the document and tables, then a signed text task, and never repeats either", async () => {
    const setup = pageSetup();
    const receipt = await setup.preparation.run(setup.input, signal());
    if (receipt.status !== "durable") {
      throw new Error(JSON.stringify(receipt));
    }
    const stored = defined(setup.remote.data.get(receipt.record.document.objectKey));
    const document = TextDocumentSchema.parse(decodeJson(stored));
    expect(document.source).toEqual(setup.input.page);
    expect(document.text).toBe("Other ingredients: water\n\n10 mg");
    const tables = decodeJson(defined(setup.remote.data.get(receipt.record.tables.objectKey)));
    expect(tables).toMatchObject([{ rows: [[{ colspan: 2 }]] }]);
    const task = await setup.text.run({ plan: setup.plan, receipt }, signal());
    if (task.status !== "prepared") {
      throw new Error(JSON.stringify(task));
    }
    expect(parseTextInput(task.task, hashString).range).toEqual({
      start: 0,
      end: document.text.length,
    });
    const writes = setup.remote.writes;
    const replacement = replacementPageSteps(setup);
    expect(await replacement.preparation.run(setup.input, signal())).toEqual(receipt);
    expect(await replacement.text.run({ plan: setup.plan, receipt: null }, signal())).toEqual(task);
    expect(setup.remote.writes).toBe(writes);
  });

  it.each([
    ["<script>fetch('https://example.test')</script>", "PROCESSING.PAGE_EMPTY"],
    ["x".repeat(200_001), "PAGE.TEXT_LIMIT"],
  ])("a page without usable text becomes a Review, never truncated (%#)", async (html, code) => {
    const setup = pageSetup(html);
    expect(await setup.preparation.run(setup.input, signal())).toMatchObject({
      status: "review",
      code,
    });
    expect(setup.remote.data.has(pageCompletionKey(setup.input))).toBe(false);
    expect(setup.remote.data.get(setup.input.page.objectKey)).toEqual(setup.bytes);
  });

  it("invalid UTF-8, a damaged or missing page and a bad fingerprint never publish", async () => {
    const utf = pageSetup();
    const bytes = Buffer.from([0xff, 0xfe]);
    const input = signedPage({
      ...utf.input,
      page: { ...utf.input.page, sha256: sha256(bytes), byteSize: bytes.length },
    });
    utf.remote.data.set(input.page.objectKey, bytes);
    expect(await utf.preparation.run(input, signal())).toMatchObject({
      code: "ARTIFACT.MEDIA_TYPE",
    });
    const setup = pageSetup();
    setup.remote.data.set(setup.input.page.objectKey, Buffer.from("bad"));
    expect(await setup.preparation.run(setup.input, signal())).toMatchObject({
      code: "ARTIFACT.INTEGRITY",
    });
    setup.remote.data.clear();
    expect(await setup.preparation.run(setup.input, signal())).toMatchObject({
      code: "PAGE.SOURCE_NOT_DURABLE",
    });
    const unsigned = { ...setup.input, inputFingerprint: "b".repeat(64) };
    expect(await setup.preparation.run(unsigned, signal())).toMatchObject({
      code: "INPUT.FINGERPRINT_MISMATCH",
    });
  });

  it("a failed publication keeps the files, and a replacement neither prepares nor uploads again", async () => {
    const setup = pageSetup();
    const documents = failWrites(setup, (key) => key.endsWith("/document.json"));
    expect(await setup.preparation.run(setup.input, signal())).toMatchObject({
      code: "PAGE.HANDOFF_UNVERIFIED",
    });
    expect(setup.local.data.has(pageCompletionKey(setup.input))).toBe(true);
    const replacement = replacementPageSteps(setup);
    expect(await replacement.preparation.run(setup.input, signal())).toMatchObject({
      code: "PAGE.EXECUTION_UNKNOWN",
    });
    expect(await replacement.text.run({ plan: setup.plan, receipt: null }, signal())).toMatchObject(
      {
        code: "PAGE.NOT_DURABLE",
      },
    );
    expect(documents.writes).toBe(1);
  });

  it("an unknown text-task upload is never retried from an empty-cache worker", async () => {
    const setup = pageSetup();
    const receipt = await setup.preparation.run(setup.input, signal());
    const tasks = failWrites(setup, (key) => key.startsWith("v3/page-text-inputs/"));
    expect(await setup.text.run({ plan: setup.plan, receipt }, signal())).toMatchObject({
      code: "PAGE.HANDOFF_UNVERIFIED",
    });
    const replacement = replacementPageSteps(setup);
    expect(await replacement.text.run({ plan: setup.plan, receipt: null }, signal())).toMatchObject(
      {
        code: "PAGE.HANDOFF_PENDING",
      },
    );
    expect(tasks.writes).toBe(1);
  });

  it("a lost completion acknowledgement is settled by reading it back", async () => {
    const setup = pageSetup();
    const completions = failWrites(setup, (key) => key === pageCompletionKey(setup.input), true);
    expect(await setup.preparation.run(setup.input, signal())).toMatchObject({ status: "durable" });
    expect(completions.writes).toBe(1);
  });

  it("a page Review passes through, a forged one is refused, and damaged tables never reach text", async () => {
    const bad = pageSetup("<script>no text</script>");
    const review = await bad.preparation.run(bad.input, signal());
    expect(await bad.text.run({ plan: bad.plan, receipt: review }, signal())).toEqual(review);
    expect(bad.records.size).toBe(1);
    const forged = { ...review, operationId: "foreign" };
    expect(await bad.text.run({ plan: bad.plan, receipt: forged }, signal())).toMatchObject({
      code: "PAGE.IDENTITY_CONFLICT",
    });
    const setup = pageSetup();
    const good = await setup.preparation.run(setup.input, signal());
    if (good.status !== "durable") {
      throw new Error(JSON.stringify(good));
    }
    setup.remote.data.set(good.record.tables.objectKey, Buffer.from("[]"));
    expect(await setup.text.run({ plan: setup.plan, receipt: good }, signal())).toMatchObject({
      status: "review",
      code: "ARTIFACT.INTEGRITY",
    });
  });

  it("an unconfirmed Review is never reported as recorded; the local copy stays", async () => {
    const setup = pageSetup();
    setup.remote.data.clear();
    setup.reviews.append = async () => Promise.reject(new Error("synthetic private connection"));
    await expect(setup.preparation.run(setup.input, signal())).rejects.toMatchObject({
      code: "PAGE.REVIEW_UNVERIFIED",
    });
    expect([...setup.local.data.keys()].some((key) => key.startsWith("page-reviews/"))).toBe(true);
  });
});
