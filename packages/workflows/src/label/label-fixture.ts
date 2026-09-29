/**
 * A page-only label product for the Label workflow's tests: every object is valid under the contract schemas the
 * workflow parses (fingerprints are only format-checked there; the activities verify them).
 */
const sha = (character: string) => character.repeat(64);

export const owner = {
  schemaVersion: 1 as const,
  requestId: "req-1",
  observationId: "obs-1",
  brandId: "brand-1",
  sourceId: "source-1",
  listingId: "listing-1",
  variantId: null,
};

function ref(at: {
  id: string;
  kind: string;
  mediaType: string;
  key: string;
  producer: [string, string, string];
}) {
  const [operationId, module, implementationVersion] = at.producer;
  return {
    schemaVersion: 1 as const,
    artifactId: at.id,
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: null,
    kind: at.kind,
    mediaType: at.mediaType,
    sha256: sha("1"),
    byteSize: 10,
    objectKey: at.key,
    producer: { operationId, module, implementationVersion },
  };
}

const json = "application/json";
const pageText = {
  schemaVersion: 1 as const,
  module: "codex.text" as const,
  implementationVersion: "codex-text/2",
  policyVersion: "anchored/2",
  resultSchemaVersion: 2 as const,
  configFingerprint: sha("a"),
};
const labelText = {
  ...pageText,
  implementationVersion: "codex-text/3",
  policyVersion: "label-text/4",
  resultSchemaVersion: 3 as const,
};

const page = ref({
  id: "page-html",
  kind: "source-html",
  mediaType: "text/html",
  key: "v3/channel-plans/plan-1/derived.html",
  producer: ["plan-1", "channel.product-input", "channel-plan/1"],
});
const pageInput = {
  ...owner,
  operationId: "page-op",
  module: "page.prepare",
  implementationVersion: "1",
  policyVersion: "1",
  configFingerprint: sha("c"),
  page,
  inputFingerprint: sha("d"),
};
const documentRef = ref({
  id: "page-document",
  kind: "result-json",
  mediaType: json,
  key: "v3/pages/page-op/document.json",
  producer: ["page-op", "page.prepare", "1"],
});

export const task = {
  operationId: "label-1",
  owner,
  plan: { operationId: "plan-1", sourceOperationId: "capture-1", input: {} },
  text: labelText,
  visionConfigFingerprint: sha("b"),
};

export const entry = {
  input: task,
  queues: { activities: "activities", ocr: "ocr", model: "model" },
};

export const manifest = {
  operationId: "plan-1",
  observation: owner,
  sources: [
    {
      id: "page",
      kind: "page",
      required: true,
      plan: { page: pageInput, textOperationId: "text-op", text: pageText },
    },
  ],
};

const pageTextTask = {
  ...owner,
  ...pageText,
  operationId: "text-op",
  inputFingerprint: sha("e"),
  source: { kind: "prepared", document: documentRef },
  range: { start: 0, end: 10 },
};
export const labelTextTask = {
  ...pageTextTask,
  ...labelText,
  operationId: "label-text-op",
  inputFingerprint: sha("f"),
};
export const labelSource = { id: "page", kind: "text", required: true, task: labelTextTask };

const resultRef = (file: string) =>
  ref({
    id: `text-${file}`,
    kind: "result-json",
    mediaType: json,
    key: `text-operations/label-text-op/${file}.json`,
    producer: ["label-text-op", "codex.text", "codex-text/3"],
  });

export const pageTextOutcome = { status: "prepared", task: pageTextTask };
export const textOutcome = {
  status: "registered",
  operationId: "label-text-op",
  result: resultRef("result"),
  completion: resultRef("completion"),
};
export const textReceipt = {
  status: "registered",
  registration: {
    schemaVersion: 1,
    storageId: "r2/1",
    input: labelTextTask,
    result: resultRef("result"),
    completion: resultRef("completion"),
  },
};
export const evidenceKey = "v3/label-products/label-1/assembly.json";
export const collected = {
  status: "collected",
  operationId: "label-1",
  observationId: owner.observationId,
  evidenceKey,
  recordHash: sha("9"),
};

/** The label steps a page-only product runs, each answering as the processing step would. */
export function pageActivities() {
  return {
    loadLabelPlan: async () => ({ input: task, manifest }),
    prepareHtmlPage: async () => {
      throw new Error("receipt lost");
    },
    preparePageText: async () => pageTextOutcome,
    prepareLabelSource: async (request: unknown) => ({
      status: "prepared",
      input: request,
      source: labelSource,
    }),
    resolveTextReceipt: async () => textReceipt,
    prepareLabelManifest: async () => ({
      input: task,
      manifest: { operationId: "label-1", observation: owner, sources: [labelSource] },
      skipped: [],
    }),
    assembleLabelProduct: async () => ({ status: "ready", evidenceKey }),
    collectLabelProduct: async () => collected,
    reviewLabelProduct: async (request: { code: string }) => ({
      status: "review",
      operationId: "label-1",
      reviewId: "label-review-1",
      code: request.code,
      evidenceKey: "v3/channel-labels/label-1/review.json",
      automaticRetry: false,
    }),
  };
}
