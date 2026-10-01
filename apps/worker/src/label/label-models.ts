import { delimiter, dirname } from "node:path";
import {
  CodexTextModel,
  CodexVisionModel,
  OcrStep,
  TextStep,
  VisionStep,
} from "@crawl-automation/processing";
import { workerErrors } from "../errors.js";
import type { LabelStores } from "./label-stores.js";
import { measuredProvider } from "@crawl-automation/platform";
import { ocrClient } from "./ocr-client.js";

/** The steps that call a model or the OCR API. Each client opens on first use, so other roles never need one. */
export interface LabelModels {
  textStep(): Promise<TextStep>;
  visionStep(): Promise<VisionStep>;
  ocrStep(verifiedFailures?: boolean): OcrStep;
  close(): Promise<void>;
}

/** The Codex process finds this Node first on its PATH, whatever the service manager set. */
function codexEnvironment(): NodeJS.ProcessEnv {
  const path = [dirname(process.execPath), process.env["PATH"]].filter(Boolean).join(delimiter);
  return { ...process.env, PATH: path };
}

function once<T>(create: () => T): () => T {
  let value: { made: T } | null = null;
  return () => {
    value ??= { made: create() };
    return value.made;
  };
}

/** The Codex clients, opened on first use; `close` closes only those that were opened. */
function modelClients(settings: LabelStores["settings"]) {
  const opened: Promise<{ close(): Promise<void> }>[] = [];
  const open = <T extends { close(): Promise<void> }>(
    part: "text" | "vision",
    client: (raw: unknown) => Promise<T>,
  ) =>
    once(async () => {
      if (!settings.codex) {
        throw missing("codex");
      }
      const opening = client(settings.codex[part]);
      opened.push(opening);
      return opening;
    });
  return {
    text: open("text", (raw) => CodexTextModel.open(raw, codexEnvironment())),
    vision: open("vision", (raw) => CodexVisionModel.open(raw, codexEnvironment())),
    close: async () => {
      await Promise.allSettled(opened.map(async (client) => (await client).close()));
    },
  };
}

const missing = (part: string) =>
  workerErrors.create("WORKER.PROCESSING_SETTINGS_MISSING", { details: { part } });

export function labelModels(stores: LabelStores): LabelModels {
  const { settings, local, remote, reviews, artifacts } = stores;
  const clients = modelClients(settings);
  const legacyOcr = once(() => createOcrStep(stores, false));
  const verifiedOcr = once(() => createOcrStep(stores, true));
  const ocrStep = (verifiedFailures = false) => (verifiedFailures ? verifiedOcr() : legacyOcr());
  const textStep = once(async () => {
    const model = measuredProvider(await clients.text(), "interpret", "model-text");
    return new TextStep({ model, results: stores.textResults, reviews, nodeId: settings.nodeId });
  });
  const visionStep = once(async () => {
    const model = measuredProvider(await clients.vision(), "interpret", "model-image");
    const { visionResults: results, ocrText } = stores;
    return new VisionStep({ model, results, ocrText, artifacts, local, remote, reviews });
  });
  return { textStep, visionStep, ocrStep, close: clients.close };
}

function createOcrStep(stores: LabelStores, verifiedFailures: boolean): OcrStep {
  const { settings, artifacts, remote, reviews } = stores;
  if (!settings.ocrApi) {
    throw missing("ocrApi");
  }
  const { nodeId, storageId } = settings;
  const api = measuredProvider(
    ocrClient(settings.ocrApi, globalThis.fetch, verifiedFailures),
    "recognize",
    "ocr",
  );
  return new OcrStep({
    api,
    artifacts,
    results: stores.ocrResults,
    remote,
    reviews,
    nodeId,
    storageId,
  });
}
