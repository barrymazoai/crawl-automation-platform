import { describe, expect, it } from "vitest";
import { PagePrepareInputSchema } from "@crawl-automation/v3-contracts";
import { preparePage, PAGE_POLICY } from "./page.js";
import { inspectMedia } from "./media.js";
import { pageInput, png, sign } from "./testing.fixture.js";
const signal = () => new AbortController().signal;
const parse = (html: string) => { const f = pageInput(html); return preparePage(f.input, f.bytes, signal()); };
describe("offline one-page preparation", () => {
    it("retains all text, units, amounts and tables without judging nutrition or running scripts", () => {
        const out = parse('<h1>Product &amp; label</h1><p>Not a supplement? Keep this.</p><script>globalThis.pwned=true</script><style>secret-css</style><table><tr><th>Ingredient</th><th>Amount</th></tr><tr><td>Vitamin C</td><td>100 mg &lt; 200 mg</td></tr></table>');
        expect(out.text).toContain("Product & label");
        expect(out.text).toContain("Not a supplement? Keep this.");
        expect(out.text).not.toContain("pwned");
        expect(out.text).not.toContain("secret-css");
        expect(out.tables[0]!.rows[1]).toEqual([{ text: "Vitamin C", header: false, rowspan: 1, colspan: 1 }, { text: "100 mg < 200 mg", header: false, rowspan: 1, colspan: 1 }]);
        expect(out).toMatchObject({ artifactDurable: false, resultRegistered: false });
    });
    it("retains spans and nested table boundaries instead of flattening or assigning amounts", () => {
        const out = parse('<table><tr><th rowspan="0" colspan="2">Group</th><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>');
        expect(out.tables).toHaveLength(2);
        expect(out.tables[0]!.rows[0]![0]).toMatchObject({ rowspan: 0, colspan: 2 });
        expect(out.tables[1]!.rows[0]![0]!.text).toBe("Inner");
        expect(out.tables[0]!.rows[0]![1]!.text).toContain("Outer");
    });
    it("has no HTML execution/fetch and retains hidden/marketing text for downstream decisions", () => {
        const out = parse('<img src="https://169.254.169.254/secret"><iframe src="https://elsewhere"></iframe><p hidden>Keep hidden source wording</p><template>omitted template</template><p onclick="evil()">Safe text</p>');
        expect(out.text).toContain("Keep hidden source wording");
        expect(out.text).not.toContain("omitted template");
        expect(out.text).not.toContain("evil()");
    });
    it("normalizes malformed HTML deterministically, not via regex stripping", () => {
        const html = '<table><tr><td>A &amp; B<td>5 mg</table><p>Final';
        expect(parse(html)).toEqual(parse(html));
        expect(parse(html).tables[0]!.rows[0]).toHaveLength(2);
    });
    it("validates ownership/hash/type/fingerprint before parsing", () => {
        const f = pageInput('<p>hello</p>');
        expect(PagePrepareInputSchema.safeParse({ ...f.input, page: { ...f.input.page, sourceId: "other" } }).success).toBe(false);
        expect(PagePrepareInputSchema.safeParse({ ...f.input, page: { ...f.input.page, kind: "text", mediaType: "text/plain" } }).success).toBe(false);
        expect(() => preparePage(f.input, Buffer.from("changed"), signal())).toThrow("ARTIFACT.INTEGRITY");
        expect(() => preparePage({ ...f.input, inputFingerprint: "a".repeat(64) }, f.bytes, signal())).toThrow("INPUT.FINGERPRINT_MISMATCH");
        expect(() => preparePage(sign({ ...f.input, policyVersion: "other" }), f.bytes, signal())).toThrow("RUNTIME.INCOMPATIBLE_CONSUMER");
    });
    it("rejects empty, over-depth, oversized and over-table inputs without truncation", () => {
        expect(() => parse('<script>not text</script>')).toThrow("PROCESSING.PAGE_EMPTY");
        expect(() => parse('<div>'.repeat(130) + 'A' + '</div>'.repeat(130))).toThrow("PROCESSING.PAGE_LIMIT");
        expect(() => parse('<table><tr><td>A</td></tr></table>'.repeat(201))).toThrow("PROCESSING.PAGE_LIMIT");
        expect(() => parse('x'.repeat(PAGE_POLICY.maxBytes + 1))).toThrow("ARTIFACT.TOO_LARGE");
        expect(() => parse('<table>'.repeat(20) + '<tr><td>' + 'x'.repeat(500000) + '</td></tr>' + '</table>'.repeat(20))).not.toThrow();
    });
    it("output amplification by deeply nested cells is bounded", () => {
        const html = '<table><tr><td>'.repeat(20) + 'x'.repeat(500000) + '</td></tr></table>'.repeat(20);
        expect(() => parse(html)).toThrow("PROCESSING.PAGE_LIMIT");
    });
    it("already cancelled page operation cannot parse", () => {
        const f = pageInput('<p>A</p>'), c = new AbortController();
        c.abort();
        expect(() => preparePage(f.input, f.bytes, c.signal)).toThrow();
    });
});
describe("container/type/dimension screening, not full decoding", () => {
    it("PNG detected from bytes with generic HTTP type; caps decoded dimensions", () => {
        expect(inspectMedia(png, "application/octet-stream", 100)).toMatchObject({ mediaType: "image/png", dimensions: { width: 1, height: 1 } });
        const giant = Buffer.from(png);
        giant.writeUInt32BE(100000, 16);
        giant.writeUInt32BE(100000, 20);
        expect(() => inspectMedia(giant, "image/png", 40000000)).toThrow("ARTIFACT.DIMENSIONS");
    });
    it("screens PDF container but does not claim PDFium parse, decryption or render", () => {
        expect(inspectMedia(Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF\n'), "application/pdf", 100)).toEqual({ mediaType: "application/pdf", dimensions: null });
        expect(() => inspectMedia(Buffer.from('%PDF-1.7\ntruncated'), "application/pdf", 100)).toThrow("ARTIFACT.INTEGRITY");
    });
    it("rejects SVG, GIF, unknown types and MIME spoofing", () => {
        for (const bytes of [Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from('garbage')])
            expect(() => inspectMedia(bytes, "image/png", 100)).toThrow("ARTIFACT.MEDIA_TYPE");
    });
});
