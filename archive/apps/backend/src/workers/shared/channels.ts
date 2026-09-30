import { createAmazonChannelHooks } from "../../v2/channels/amazon.js";
import { createGncChannelHooks } from "../../v2/channels/gnc.js";
import { createSwansonChannelHooks } from "../../v2/channels/swanson.js";
import { createDtcChannelHooks } from "../../v2/channels/dtc.js";
import type { ChannelHooks, StageContext } from "../../v2/stages.js";
import type { ProductDeps } from "./deps.js";

/**
 * 渠道钩子注册表：新增一个渠道 = 在 v2/channels/ 下写一个钩子实现 + 在这里加一行。
 * 编排逻辑一律在 v2/stages.ts，不在渠道文件里。
 */
export function channelRegistry(config: { pdfRenderScript: string }): Record<string, ChannelHooks<any, any, any>> {
  return {
    gnc: createGncChannelHooks({ pdfRenderScript: config.pdfRenderScript }),
    amazon: createAmazonChannelHooks(),
    swanson: createSwansonChannelHooks(),
    dtc: createDtcChannelHooks(),
  };
}

/** run 的 source.adapter 为空表示 DTC（独立站）。 */
export function channelKey(adapter: string | null | undefined) {
  return adapter ?? "dtc";
}

export function hooksFor(registry: Record<string, ChannelHooks<any, any, any>>, adapter: string | null | undefined) {
  const key = channelKey(adapter);
  const hooks = registry[key];
  if (!hooks) throw new Error(`unsupported_channel:${key}`);
  return hooks;
}

export function buildStageContext(input: {
  deps: ProductDeps;
  workRoot: string;
  runId: string;
  sourceUrl: string;
  signal: AbortSignal;
  ocrConcurrency: number;
  forcePartialScope: boolean;
  runModel: StageContext["runModel"];
  noCompanyStore?: StageContext["noCompanyStore"];
}): StageContext {
  return {
    workRoot: input.workRoot,
    runId: input.runId,
    sourceUrl: input.sourceUrl,
    signal: input.signal,
    ocr: input.deps.ocr,
    supplySmart: input.deps.supplySmart,
    productWriter: input.deps.productWriter,
    ocrConcurrency: input.ocrConcurrency,
    forcePartialScope: input.forcePartialScope,
    runModel: input.runModel,
    ...(input.noCompanyStore ? { noCompanyStore: input.noCompanyStore } : {}),
  };
}
