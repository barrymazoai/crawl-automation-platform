import { screenKeywords, type SavedFormula } from "@crawl-automation/processing";
import { describe, expect, it, vi } from "vitest";
import { FormulaLookup, formulaChannels } from "./formula-lookup.js";
import type {
  FormulaFamilies,
  FormulaIndex,
  FormulaLink,
  FormulaLinks,
  FormulaQuery,
  LabelImageText,
} from "./ports.js";
import { SiblingFormulaReuse } from "./sibling-reuse.js";

const families: FormulaFamilies = { channels: (channel) => [channel] };

const LABEL = "Serving Size 2 Capsules\nD-Ribose 500 mg\nOther Ingredients: Rice Flour, Gelatin.";
const field = (text: string) => ({
  text,
  sourceId: "s",
  citation: { kind: "image", evidence: text },
});
const SAVED = {
  formula: {
    servingSize: field("2 Capsules"),
    servingsPerContainer: field("30"),
    columns: [
      {
        heading: null,
        rows: [
          {
            kind: "ingredient",
            name: field("D-Ribose"),
            amount: field("500 mg"),
            dailyValue: null,
            amountStatus: "printed",
            parentRowIndex: null,
          },
        ],
      },
    ],
  },
  otherIngredients: {
    heading: field("Other Ingredients"),
    items: [field("Rice Flour"), field("Gelatin")],
  },
} as unknown as SavedFormula;

const member = (listingId: string, label: string) => ({
  listingId,
  variantId: null,
  url: `https://www.swansonvitamins.com/p/${listingId}`,
  label,
});

function request(changes: Record<string, unknown> = {}) {
  return {
    runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
    channel: "swanson",
    listingId: "ribose-120",
    variantId: null,
    labelText: LABEL,
    family: {
      differsBy: "size",
      group: "Size",
      selectedLabel: "120 Caps",
      members: [member("ribose-30", "30 Caps"), member("ribose-60", "60 Caps")],
    },
    ...changes,
  };
}

/** A facts image's keyword selection, as the Label workflow's OCR and keyword steps return it. */
function factsImageSelection() {
  const owner = { listingId: "ribose-120", sourceId: "source-1", observationId: "obs-1" };
  return screenKeywords({
    observation: {
      schemaVersion: 1,
      requestId: "req-1",
      brandId: "brand-1",
      variantId: null,
      ...owner,
    },
    image: {
      schemaVersion: 1,
      artifactId: "image-2",
      variantId: null,
      ...owner,
      kind: "source-image",
      mediaType: "image/jpeg",
      objectKey: "sources/image-2.jpg",
      sha256: "c".repeat(64),
      byteSize: 1000,
      producer: { operationId: "file-2", module: "file.acquire", implementationVersion: "1" },
    },
    ocrOperationId: "ocr-2",
    text: `Supplement Facts\n${LABEL}`,
  });
}

function setup(
  known: Record<string, string> = { "ribose-60": "formula-60" },
  ocrText = `Supplement Facts\n${LABEL}`,
  familyPort = families,
) {
  const index: FormulaIndex = {
    findKnown: vi.fn(async () => null),
    findForMember: vi.fn(async (query: FormulaQuery) => {
      const operationId = known[query.listingId];
      return operationId ? { operationId } : null;
    }),
    readSaved: vi.fn(async () => SAVED),
  };
  const links: FormulaLinks & { saved: FormulaLink[] } = {
    saved: [],
    record: vi.fn(async (link: FormulaLink) => {
      links.saved.push(link);
      return link;
    }),
  };
  const labelImages: LabelImageText = { verifiedText: vi.fn(async () => ocrText) };
  const reuse = new SiblingFormulaReuse({ index, links, labelImages, families: familyPort });
  return { index, links, labelImages, reuse };
}

describe("sibling formula reuse", () => {
  it("links a size sibling's formula when the label prints exactly that formula", async () => {
    const { reuse, links } = setup();
    expect(await reuse.reuse(request())).toMatchObject({
      status: "reused",
      formulaOperationId: "formula-60",
      siblingListingId: "ribose-60",
    });
    expect(links.saved).toHaveLength(1);
    expect(links.saved[0]?.evidence).toMatchObject({
      labelText: LABEL,
      check: "label-text-match/1",
    });
  });

  it("extracts in full when the label differs from the sibling's formula", async () => {
    const { reuse, links } = setup();
    const other = request({ labelText: LABEL.replace("500 mg", "250 mg") });
    expect(await reuse.reuse(other)).toEqual({
      status: "extract",
      reason: "FORMULA.LABEL_MISMATCH",
    });
    expect(links.saved).toHaveLength(0);
  });

  it.each([
    [
      {
        family: {
          differsBy: "flavour",
          group: "Flavor",
          selectedLabel: "Vanilla",
          members: [member("a", "Cocoa")],
        },
      },
      "FORMULA.FAMILY_DIFFERS_BY_FLAVOUR",
    ],
    [
      {
        family: {
          differsBy: "strength",
          group: "Size",
          selectedLabel: "100 mg",
          members: [member("a", "200 mg")],
        },
      },
      "FORMULA.FAMILY_DIFFERS_BY_STRENGTH",
    ],
    [{ family: { members: [] } }, "FORMULA.FAMILY_UNREADABLE"],
    [{ labelText: null }, "FORMULA.LABEL_TEXT_UNAVAILABLE"],
  ])(
    "never reuses across other differences or without the label text: %j",
    async (changes, reason) => {
      const { reuse, index } = setup();
      expect(await reuse.reuse(request(changes))).toEqual({ status: "extract", reason });
      expect(index.readSaved).not.toHaveBeenCalled();
    },
  );

  it("extracts in full when no family member has a formula yet", async () => {
    const { reuse } = setup({});
    expect(await reuse.reuse(request())).toEqual({
      status: "extract",
      reason: "FORMULA.NO_SIBLING_FORMULA",
    });
  });
});

describe("sibling formula reuse by the facts image's OCR text", () => {
  const noText = (changes: Record<string, unknown> = {}) =>
    request({ labelText: null, labelImage: factsImageSelection(), ...changes });

  it("links the sibling's formula when the facts image prints exactly that formula", async () => {
    const { reuse, links, labelImages } = setup();
    expect(await reuse.reuse(noText())).toMatchObject({
      status: "reused",
      formulaOperationId: "formula-60",
    });
    expect(labelImages.verifiedText).toHaveBeenCalledOnce();
    expect(links.saved[0]?.evidence).toMatchObject({
      check: "label-ocr-match/1",
      labelImage: { ocrOperationId: "ocr-2", imageId: "image-2" },
    });
  });

  it("extracts in full when the facts image differs from the sibling's formula", async () => {
    const { reuse, links } = setup(undefined, LABEL.replace("500 mg", "250 mg"));
    expect(await reuse.reuse(noText())).toEqual({
      status: "extract",
      reason: "FORMULA.LABEL_MISMATCH",
    });
    expect(links.saved).toHaveLength(0);
  });

  it("asks for a label only once a sibling formula exists, and never reads an image it was not given", async () => {
    const { reuse, labelImages } = setup();
    expect(await reuse.reuse(request({ labelText: null }))).toEqual({
      status: "extract",
      reason: "FORMULA.LABEL_TEXT_UNAVAILABLE",
    });
    const none = setup({});
    expect(await none.reuse.reuse(noText())).toEqual({
      status: "extract",
      reason: "FORMULA.NO_SIBLING_FORMULA",
    });
    expect(labelImages.verifiedText).not.toHaveBeenCalled();
    expect(none.labelImages.verifiedText).not.toHaveBeenCalled();
  });

  it("an OCR text that cannot be verified fails the ask (a Review), never a silent reuse", async () => {
    const { reuse, labelImages, links } = setup();
    vi.mocked(labelImages.verifiedText).mockRejectedValue(new Error("SCREEN.UPSTREAM_UNVERIFIED"));
    await expect(reuse.reuse(noText())).rejects.toThrow();
    expect(links.saved).toHaveLength(0);
  });
});

describe("formula family across channels", () => {
  it("uses the formula family supplied by the port", async () => {
    const families: FormulaFamilies = {
      channels: (channel) => (channel === "swanson" ? [channel] : ["amazon", "wholefoods"]),
    };
    expect(formulaChannels("wholefoods", families)).toEqual(["amazon", "wholefoods"]);
    expect(formulaChannels("amazon", families)).toEqual(["amazon", "wholefoods"]);
    expect(formulaChannels("swanson", families)).toEqual(["swanson"]);
    const findKnown = vi.fn(async () => ({ operationId: "amazon-formula" }));
    const lookup = new FormulaLookup({ findKnown }, families);
    const key = { channel: "wholefoods" as const, listingId: "B002CQU54Q", variantId: null };
    expect(await lookup.findKnown(key)).toEqual({ operationId: "amazon-formula" });
    expect(findKnown).toHaveBeenCalledWith({
      channels: ["amazon", "wholefoods"],
      listingId: "B002CQU54Q",
      variantId: null,
    });
  });
});

it("uses the supplied family for sibling lookups too", async () => {
  const families = { channels: vi.fn(() => ["gnc", "swanson"]) };
  const { reuse, index } = setup(undefined, undefined, families);
  await reuse.reuse(request());
  expect(families.channels).toHaveBeenCalledWith("swanson");
  expect(index.findForMember).toHaveBeenCalledWith(
    expect.objectContaining({
      channels: ["gnc", "swanson"],
    }),
  );
});
