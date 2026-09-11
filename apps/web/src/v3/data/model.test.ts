import { describe, expect, it } from "vitest";
import {
  advanceRun,
  importBrands,
  metrics,
  nextOccurrence,
  previewImport,
  safeUrl,
  saveBrand,
  saveSchedule,
  seed,
  startRuns,
  StateSchema,
} from "./model";

describe("V3 demo business boundaries", () => {
  it("validates its seed and separates saved data from Review", () => {
    const state = StateSchema.parse(seed());
    expect(metrics(state)).toMatchObject({
      brands: 8,
      saved: 32,
      review: 4,
      unmapped: 12,
    });
  });
  it("creates brands without a formal company", () => {
    const state = seed();
    const id = saveBrand(state, {
      name: " Independent ",
      company: "",
      note: "",
    });
    expect(state.brands.find((b) => b.id === id)).toMatchObject({
      name: "Independent",
      company: "",
    });
    expect(() =>
      saveBrand(state, { name: "independent", company: "", note: "" }),
    ).toThrow();
  });
  it("rejects unsafe source URLs and strips fragments", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/a",
      "https://user:pass@example.com",
    ])
      expect(() => safeUrl(url)).toThrow();
    expect(safeUrl("https://example.com/a#label")).toBe(
      "https://example.com/a",
    );
  });
  it("skips source overlap across manual and schedule triggers", () => {
    const state = seed();
    expect(startRuns(state, ["ag1-dtc", "ag1-dtc", "thorne-amazon"])).toEqual({
      created: 1,
      skipped: 1,
    });
    expect(startRuns(state, ["ag1-dtc"], "定时计划")).toEqual({
      created: 0,
      skipped: 1,
    });
  });
  it("keeps task source snapshots independent from later edits", () => {
    const state = seed();
    startRuns(state, ["ag1-dtc"]);
    state.sources.find((s) => s.id === "ag1-dtc")!.url =
      "https://changed.example/";
    expect(state.runs[0]!.sourceSnapshot.url).not.toContain("changed");
  });
  it("saves an unmapped product once and permits a later new round", () => {
    const state = seed(),
      before = state.products.length;
    startRuns(state, ["ag1-dtc"]);
    const id = state.runs[0]!.id;
    for (let i = 0; i < 6; i++) advanceRun(state, id);
    expect(state.products).toHaveLength(before + 1);
    expect(state.products[0]).toMatchObject({ status: "unmapped", error: "" });
    expect(startRuns(state, ["ag1-dtc"]).created).toBe(1);
  });
  it("does not treat completion as formal synchronization or retry Review", () => {
    const state = seed(),
      review = state.products.filter((p) => p.status === "review");
    advanceRun(state, "run-demo-3");
    expect(state.products[0]!.status).toBe("saved");
    expect(state.products.filter((p) => p.status === "review")).toEqual(review);
  });
  it("rechecks imports at commit time and never overwrites existing brands", () => {
    const state = seed();
    const rows = previewImport(
      state,
      JSON.stringify([{ externalId: "test:1", name: "Test Import" }]),
    );
    expect(importBrands(state, rows)).toBe(1);
    expect(importBrands(state, rows)).toBe(0);
    expect(
      previewImport(
        state,
        JSON.stringify([{ externalId: "test:2", name: "Thorne" }]),
      )[0]!.action,
    ).toBe("conflict");
  });
  it("rejects duplicate external IDs in a single import", () => {
    expect(() =>
      previewImport(
        seed(),
        JSON.stringify([
          { externalId: "a", name: "One" },
          { externalId: "a", name: "Two" },
        ]),
      ),
    ).toThrow();
  });
  it("preserves a paused schedule when editing and leaves in-flight tasks intact", () => {
    const state = seed(),
      plan = state.schedules[2]!,
      runs = structuredClone(state.runs);
    saveSchedule(state, { ...plan, name: "Updated" }, plan.id);
    expect(plan.enabled).toBe(false);
    expect(nextOccurrence(plan)).toBe("已暂停");
    expect(state.runs).toEqual(runs);
  });
  it("previews time zones and skips weekends", () => {
    const state = seed();
    expect(nextOccurrence(state.schedules[0]!)).toBe("09/06 09:00");
    expect(nextOccurrence(state.schedules[1]!)).toBe("09/07 02:00");
  });
});
