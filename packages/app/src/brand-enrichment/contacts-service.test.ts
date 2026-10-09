import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrandContactsService } from "./contacts-service.js";
import type { SupplySmartContacts } from "./ports.js";
import type { TitleClassifier } from "./task-ports.js";
import { seededRuns } from "./testing/memory-runs.js";
import { signal } from "./testing/fakes.js";

it("reuses only in-taxonomy titles and asks Codex once for each distinct unresolved title", async () => {
  const store = await seededRuns();
  const titles = ["CEO", "Sales VP", "Sales VP", "Unknown"];
  const contacts = {
    ofCompany: vi.fn<SupplySmartContacts["ofCompany"]>(async () =>
      titles.map((title) => ({
        id: randomUUID(),
        name: "Person",
        title,
        position: null,
        contactPositionLevel: null,
        contactPositionFunction: null,
      })),
    ),
    positionTaxonomy: vi.fn<SupplySmartContacts["positionTaxonomy"]>(async () => ({
      functions: ["executive", "sales"],
      levels: ["chief", "vp"],
    })),
    knownPositions: vi.fn<SupplySmartContacts["knownPositions"]>(async () => [
      {
        title: "CEO",
        normalizedTitle: "ceo",
        status: "known",
        function: "executive",
        level: "chief",
        seenCount: 10,
        share: 1,
      },
      {
        title: "Sales VP",
        normalizedTitle: "sales vp",
        status: "known",
        function: "off-list",
        level: "vp",
        seenCount: 10,
        share: 1,
      },
    ]),
    classifyPositions: vi.fn<SupplySmartContacts["classifyPositions"]>(async () => ({
      updated: 4,
      skipped: 0,
    })),
  };
  const classifier = {
    classify: vi.fn<TitleClassifier["classify"]>(async () => [
      { title: "Sales VP", function: "sales", level: "vp" },
      { title: "Unknown", function: "executive", level: "chief" },
    ]),
  };
  await new BrandContactsService({ ...store, contacts, classifier }).classify(store.runId, signal);
  expect(classifier.classify.mock.calls[0]?.[0].titles).toEqual(["Sales VP", "Unknown"]);
  const output = contacts.classifyPositions.mock.calls[0]?.[0];
  expect(output?.map((item) => item.method)).toEqual(["reused", "codex", "codex", "codex"]);
  expect(output?.some((item) => item.function === "off-list")).toBe(false);
});
