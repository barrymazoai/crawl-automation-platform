import { it, expect } from "vitest";
import { TextOutputSchema, textFingerprint, textIdentity } from "@crawl-automation/v3-contracts";
import { AnchoredExtractionSchema, decodeTextResponse, evidenceLines, resolveAnchor } from "./extraction.js";
import { fixture, signal } from "./testing.fixture.js";
import { hashText } from "./handoff.js";
import { TextModule } from "./module.js";
import { z } from "zod";
const source = "Supplement Facts\nServing Size 1 Scoop\nProtein\n9 g\nBrain Blend\n10 g\nCollagen, Ashwagandha\nOther ingredients: organic apple\ncider vinegar, water\nCONTAINS: Egg, Fish.";
const a = (line: number, text: string, toLine = line) => ({ fromLine: line, toLine, text });
function response() {
    return { formula: { servingSize: a(2, "Serving Size 1 Scoop"), nutrients: [
        { name: a(3, "Protein"), amount: a(4, "9 g"), dailyValue: null },
        { name: a(5, "Brain Blend"), amount: a(6, "10 g"), dailyValue: null },
    ] }, ingredients: { items: [
        { quote: a(7, "Collagen"), role: "blend_component" as const, parentNutrientIndex: 1 },
        { quote: a(7, "Ashwagandha"), role: "blend_component" as const, parentNutrientIndex: 1 },
        { quote: a(8, "organic apple cider vinegar", 9), role: "other" as const, parentNutrientIndex: null },
        { quote: a(9, "water"), role: "other" as const, parentNutrientIndex: null },
    ] }, excluded: [ { quote: a(1, "Supplement Facts"), reason: "heading" },
        { quote: a(8, "Other ingredients:"), reason: "heading" }, { quote: a(10, "CONTAINS: Egg, Fish."), reason: "allergen" } ], issues: [] };
}
function setup(text = source) {
    const f = fixture(text), input = { ...f.input, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const };
    input.inputFingerprint = textFingerprint(input, hashText);
    return { f, input, decode: (v: unknown) => decodeTextResponse(input, text, JSON.stringify(v)) };
}
it("resolves all citations including wrapped ingredients and preserves roles", () => {
    const { decode } = setup(), out = decode(response());
    expect(out.ingredients!.items[2]).toMatchObject({ text: "organic apple\ncider vinegar", role: "other", parentNutrientIndex: null });
    for (const q of out.ingredients!.items) expect(source.slice(q.start, q.end)).toBe(q.text);
    expect(out.ingredients!.items[0]).toMatchObject({ role: "blend_component", parentNutrientIndex: 1 });
});
it("resolves absolute UTF-16 offsets for a nonzero range, emoji and CRLF", () => {
    const text = "prefix😀\r\nOther ingredients: apple\r\ncider vinegar";
    const { input } = setup(text); input.range.start = 10;
    const q = resolveAnchor(a(1, "apple cider vinegar", 2), evidenceLines(input, text), text);
    expect(q).toEqual({ text: "apple\r\ncider vinegar", start: text.indexOf("apple"), end: text.length });
});
it.each([
    a(0, "Protein"), a(100, "Protein"), a(3, "Protein", 2), a(2, "Protein", 3), a(3, "Iron"),
])("rejects fabricated/wrong/non-tight anchors %j", anchor => {
    const { input } = setup(); expect(() => resolveAnchor(anchor, evidenceLines(input, source), source)).toThrow("TEXT.CITATION_INVALID");
});
it("rejects ambiguous repeated citations and treats regex characters literally", () => {
    const text = "10 mg 10 mg\nVitamin (C)+"; const { input } = setup(text), lines = evidenceLines(input, text);
    expect(() => resolveAnchor(a(1, "10 mg"), lines, text)).toThrow("TEXT.CITATION_INVALID");
    expect(resolveAnchor(a(2, "Vitamin (C)+"), lines, text).text).toBe("Vitamin (C)+");
});
it("rejects omitted nutrients even with otherwise correct citations", () => {
    const { decode } = setup(), raw = response(); raw.formula.nutrients.splice(0, 1); raw.ingredients.items[0]!.parentNutrientIndex = 0; raw.ingredients.items[1]!.parentNutrientIndex = 0;
    expect(() => decode(raw)).toThrow("TEXT.EXTRACTION_INCOMPLETE");
});
it("rejects omitted ingredients within an otherwise covered line", () => {
    const { decode } = setup(), raw = response(); raw.ingredients.items.splice(1, 1);
    expect(() => decode(raw)).toThrow("TEXT.EXTRACTION_INCOMPLETE");
});
it.each(["marketing", "noise", "heading"])("cannot launder an omitted nutrient as %s", reason => {
    const { decode } = setup(), raw = response(); raw.excluded.push({ quote: a(3, "Protein"), reason });
    expect(() => decode(raw)).toThrow("TEXT.COVERAGE_UNCERTAIN");
});
it("does not split apple cider vinegar at a line break", () => {
    const { decode } = setup(), raw = response(); raw.ingredients.items.splice(2, 1,
        { quote: a(8, "organic apple"), role: "other", parentNutrientIndex: null },
        { quote: a(9, "cider vinegar"), role: "other", parentNutrientIndex: null });
    expect(() => decode(raw)).toThrow("TEXT.INGREDIENT_BOUNDARY");
});
it("does not merge comma-separated ingredients", () => {
    const { decode } = setup(), raw = response(); raw.ingredients.items.splice(0, 2,
        { quote: a(7, "Collagen, Ashwagandha"), role: "blend_component", parentNutrientIndex: 1 });
    expect(() => decode(raw)).toThrow("TEXT.INGREDIENT_BOUNDARY");
});
it("requires a valid blend parent and keeps other ingredients out of blends", () => {
    const { decode } = setup(), raw = response(); raw.ingredients.items[0]!.parentNutrientIndex = 0;
    expect(() => decode(raw)).toThrow("TEXT.ROLE_INVALID");
    raw.ingredients.items[0]!.parentNutrientIndex = 1;
    Object.assign(raw.ingredients.items[2]!, { role: "blend_component", parentNutrientIndex: 1 });
    expect(() => decode(raw)).toThrow("TEXT.ROLE_INVALID");
});
it("requires explicit Other ingredients context and rejects allergen tails", () => {
    const { decode } = setup("wheat, sesame, shellfish, fish, egg.");
    expect(() => decode({ formula: null, ingredients: { items: [{ quote: a(1, "wheat"), role: "other", parentNutrientIndex: null }] }, excluded: [], issues: [] })).toThrow("TEXT.ROLE_INVALID");
});
it("never promotes Contains items into ingredients", () => {
    const { decode } = setup(), raw = response(); raw.ingredients.items.push({ quote: a(10, "Egg"), role: "other", parentNutrientIndex: null });
    expect(() => decode(raw)).toThrow("TEXT.ROLE_INVALID");
});
it("explicit missing/ambiguous input does not register even with full coverage", () => {
    expect(() => setup().decode({ ...response(), issues: ["missing_text"] })).toThrow("TEXT.INPUT_INCOMPLETE");
});
it("empty content cannot pass just because fields are nullable", () => {
    expect(() => setup().decode({ formula: null, ingredients: null, excluded: [], issues: [] })).toThrow("TEXT.EXTRACTION_INCOMPLETE");
});
it("coverage includes supplementary Unicode letters, not only individual UTF-16 units", () => {
    expect(() => setup("𠮷").decode({ formula: null, ingredients: null, excluded: [], issues: [] })).toThrow("TEXT.EXTRACTION_INCOMPLETE");
});
it("an alternate serving cannot hide missing nutrients on a single-column label", () => {
    const raw = response(); raw.excluded.push({ quote: a(4, "9 g"), reason: "alternate_serving" });
    expect(() => setup().decode(raw)).toThrow("TEXT.COVERAGE_UNCERTAIN");
});
it("wire JSON schema is strict, no offsets, and old output version cannot wrap V2", () => {
    expect(JSON.stringify(z.toJSONSchema(AnchoredExtractionSchema))).not.toContain('"start"');
    const { input, decode } = setup();
    expect(TextOutputSchema.safeParse({ ...textIdentity(input), resultSchemaVersion: 1, provider: "fixture/1", rawResponse: JSON.stringify(response()), candidate: decode(response()) }).success).toBe(false);
});
it("V2 handoff re-decodes raw evidence on fresh-cache replay, without a second model run", async () => {
    const { input, f } = setup(); let calls = 0;
    const provider = { ...f.provider, supported: { ...f.provider.supported, implementationVersion: input.implementationVersion, policyVersion: input.policyVersion, resultSchemaVersion: 2 as const },
        interpret: async () => { calls++; return JSON.stringify(response()); } };
    const module = new TextModule({ ...f.deps, provider });
    expect(await module.run(input, signal())).toMatchObject({ status: "registered" });
    f.local.data.clear();
    expect(await module.run(input, signal())).toMatchObject({ status: "registered" });
    expect(calls).toBe(1);
    const record = f.registry.data.get(input.operationId)!;
    const output = JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString());
    output.candidate.ingredients.items[0].parentNutrientIndex = 0;
    await expect(f.handoff.capture(input, output, signal())).rejects.toThrow("TEXT.RESULT_INTEGRITY");
});
it("quality failures retain raw responses and redelivery never calls the model again", async () => {
    const { input, f } = setup(); let calls = 0;
    const raw = JSON.stringify({ ...response(), issues: ["missing_text"] });
    const provider = { ...f.provider, supported: { ...f.provider.supported, implementationVersion: input.implementationVersion, policyVersion: input.policyVersion, resultSchemaVersion: 2 as const }, interpret: async () => { calls++; return raw; } };
    const module = new TextModule({ ...f.deps, provider });
    expect(await module.run(input, signal())).toMatchObject({ status: "review", code: "TEXT.INPUT_INCOMPLETE" });
    expect([...f.reviews.records.values()][0]!.candidate?.value).toEqual({ rawResponse: raw });
    expect(await module.run(input, signal())).toMatchObject({ status: "review", code: "TEXT.EXECUTION_UNKNOWN" });
    expect(calls).toBe(1); expect(f.registry.data.size).toBe(0);
});
