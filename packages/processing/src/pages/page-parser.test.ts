import { describe, expect, it } from "vitest";
import { PagePrepareInputSchema } from "@crawl-automation/v3-contracts";
import { pageTask, signedPage } from "../testing/page-fixture.js";
import { checkedPageInput, pagePolicy } from "./page-input.js";
import { parsePage } from "./page-parser.js";

const signal = () => new AbortController().signal;
const parse = (html: string) => {
  const task = pageTask(html);
  return parsePage(task.input, task.bytes, signal());
};
const code = (expected: string) => expect.objectContaining({ code: expected });

// Cases carried over from the former page parser.
describe("page parser", () => {
  it("keeps all text, units, amounts and tables; never runs scripts or judges nutrition", () => {
    const page = parse(
      "<h1>Product &amp; label</h1><p>Not a supplement? Keep this.</p><script>globalThis.pwned=true</script>" +
        "<style>secret-css</style><table><tr><th>Ingredient</th><th>Amount</th></tr>" +
        "<tr><td>Vitamin C</td><td>100 mg &lt; 200 mg</td></tr></table>",
    );
    expect(page.text).toContain("Product & label");
    expect(page.text).toContain("Not a supplement? Keep this.");
    expect(page.text).not.toContain("pwned");
    expect(page.text).not.toContain("secret-css");
    expect(page.tables[0]?.rows[1]).toEqual([
      { text: "Vitamin C", header: false, rowspan: 1, colspan: 1 },
      { text: "100 mg < 200 mg", header: false, rowspan: 1, colspan: 1 },
    ]);
  });

  it("keeps spans and nested tables instead of flattening them or assigning amounts", () => {
    const page = parse(
      '<table><tr><th rowspan="0" colspan="2">Group</th><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>',
    );
    expect(page.tables).toHaveLength(2);
    expect(page.tables[0]?.rows[0]?.[0]).toMatchObject({ rowspan: 0, colspan: 2 });
    expect(page.tables[1]?.rows[0]?.[0]?.text).toBe("Inner");
    expect(page.tables[0]?.rows[0]?.[1]?.text).toContain("Outer");
  });

  it("never fetches or executes, and keeps hidden text for later decisions", () => {
    const page = parse(
      '<img src="https://169.254.169.254/secret"><iframe src="https://elsewhere"></iframe>' +
        '<p hidden>Keep hidden source wording</p><template>omitted template</template><p onclick="evil()">Safe text</p>',
    );
    expect(page.text).toContain("Keep hidden source wording");
    expect(page.text).not.toContain("omitted template");
    expect(page.text).not.toContain("evil()");
  });

  it("reads malformed HTML the same way every time", () => {
    const html = "<table><tr><td>A &amp; B<td>5 mg</table><p>Final";
    expect(parse(html)).toEqual(parse(html));
    expect(parse(html).tables[0]?.rows[0]).toHaveLength(2);
  });

  it("checks ownership, bytes, setup and fingerprint before parsing", () => {
    const { input, bytes } = pageTask("<p>hello</p>");
    const otherSource = { ...input, page: { ...input.page, sourceId: "other" } };
    expect(PagePrepareInputSchema.safeParse(otherSource).success).toBe(false);
    const plainText = { ...input, page: { ...input.page, kind: "text", mediaType: "text/plain" } };
    expect(PagePrepareInputSchema.safeParse(plainText).success).toBe(false);
    expect(() => parsePage(input, Buffer.from("changed"), signal())).toThrow(
      code("ARTIFACT.INTEGRITY"),
    );
    expect(() => checkedPageInput({ ...input, inputFingerprint: "a".repeat(64) })).toThrow(
      code("INPUT.FINGERPRINT_MISMATCH"),
    );
    expect(() => checkedPageInput(signedPage({ ...input, policyVersion: "other" }))).toThrow(
      code("RUNTIME.INCOMPATIBLE_CONSUMER"),
    );
    expect(parsePage(input, bytes, signal()).text).toBe("hello");
  });

  it("refuses empty, too deep, too large and too many tables, without truncating", () => {
    expect(() => parse("<script>not text</script>")).toThrow(code("PROCESSING.PAGE_EMPTY"));
    expect(() => parse("<div>".repeat(130) + "A" + "</div>".repeat(130))).toThrow(
      code("PROCESSING.PAGE_LIMIT"),
    );
    expect(() => parse("<table><tr><td>A</td></tr></table>".repeat(201))).toThrow(
      code("PROCESSING.PAGE_LIMIT"),
    );
    expect(() => parse("x".repeat(pagePolicy.maxBytes + 1))).toThrow(code("ARTIFACT.TOO_LARGE"));
    const nestedTables =
      "<table>".repeat(20) +
      "<tr><td>" +
      "x".repeat(500_000) +
      "</td></tr>" +
      "</table>".repeat(20);
    expect(() => parse(nestedTables)).not.toThrow();
  });

  it("bounds text copied into deeply nested cells", () => {
    const html =
      "<table><tr><td>".repeat(20) + "x".repeat(500_000) + "</td></tr></table>".repeat(20);
    expect(() => parse(html)).toThrow(code("PROCESSING.PAGE_LIMIT"));
  });

  it("never parses once cancelled", () => {
    const { input, bytes } = pageTask("<p>A</p>");
    const controller = new AbortController();
    controller.abort();
    expect(() => parsePage(input, bytes, controller.signal)).toThrow();
  });
});
