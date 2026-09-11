import { expect, it, vi } from "vitest";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { KeywordPublication, keywordKey } from "./keyword-publication.js";
import { selection, candidate } from "./testing.fixture.js";
import { validateVision } from "./extraction.js";
const signal = () => AbortSignal.timeout(5000);
it.each(["Supplement Facts", "marketing only"])("publishes %s and fresh-cache replay only reads", async text => {
  const local = new MemoryObjects(), remote = new MemoryObjects(), result = selection(text);
  const receipt = await new KeywordPublication(local, remote).publish(result, signal()), before = remote.writes;
  expect(receipt.evidenceKey).toBe(keywordKey(result));
  expect(await new KeywordPublication(new MemoryObjects(), remote).publish(result, signal())).toEqual(receipt);
  expect(remote.writes).toBe(before);
});
it("lost acknowledgment reads back once, no repeat upload", async () => {
  const remote = new MemoryObjects(); remote.unknown = true;
  await new KeywordPublication(new MemoryObjects(), remote).publish(selection(), signal());
  expect(remote.writes).toBe(1);
});
it("corrupted publication or local pending handoff cannot report no-match success", async () => {
  const local = new MemoryObjects(), remote = new MemoryObjects(), result = selection("marketing");
  const original = remote.create.bind(remote);
  const create = vi.spyOn(remote, "create").mockRejectedValue(Error("offline"));
  const p = new KeywordPublication(local, remote);
  await expect(p.publish(result, signal())).rejects.toThrow();
  create.mockImplementation(original);
  await expect(p.publish(result, signal())).rejects.toThrow("SCREEN.HANDOFF_PENDING");
  expect(create).toHaveBeenCalledTimes(1);
  remote.data.set(keywordKey(result), Buffer.from("corrupt"));
  await expect(p.publish(result, signal())).rejects.toThrow("SCREEN.PUBLICATION_CONFLICT");
});
it("ingredients-only blend parents defer validation to product join, but never omit parent name", () => {
  const partial = { ...candidate, formula: null, formulaComplete: false, issues: [{ code: "FORMULA_MISSING", detail: "Separate image" }] };
  expect(validateVision(JSON.stringify(partial)).status).toBe("partial");
  expect(validateVision(JSON.stringify({ ...partial, ingredients: [{ ...candidate.ingredients[0], parentBlend: null }] })).code).toBe("VISION.ROLE_INVALID");
});
