import { OcrClient } from "@crawl-automation/ocr-client";
import { SupplySmartDatabase } from "../../supply-smart-ingest.js";
import { ProductObservationClient } from "../../product-observation-client.js";

export interface ProductEnv {
  PRODUCT_DATABASE_URL: string;
  PRODUCT_SERVER_URL: string;
  PRODUCT_SERVER_TOKEN?: string | undefined;
  PRODUCT_SERVER_API_KEY?: string | undefined;
  OCR_ENDPOINT: string;
}

/**
 * 处理线共用的轻量客户端：OCR（HTTP）、产品库（只读）、Product Server（写入）。
 * 它们没有独占资源、可以在多个 Pool 进程里各建一份，和 Chrome 那种带文件锁的
 * 单例完全不同——这也是为什么处理线可以随意横向拆进程。
 */
export function createProductDeps(env: ProductEnv) {
  const ocr = new OcrClient({ endpoint: env.OCR_ENDPOINT, timeoutMs: 30_000, retries: 2 });
  const supplySmart = SupplySmartDatabase.fromDatabaseUrl(env.PRODUCT_DATABASE_URL);
  const productWriter = new ProductObservationClient({
    baseUrl: env.PRODUCT_SERVER_URL,
    ...(env.PRODUCT_SERVER_TOKEN ? { token: env.PRODUCT_SERVER_TOKEN } : {}),
    ...(env.PRODUCT_SERVER_API_KEY ? { apiKey: env.PRODUCT_SERVER_API_KEY } : {}),
  });
  return { ocr, supplySmart, productWriter, close: () => supplySmart.close() };
}

export type ProductDeps = ReturnType<typeof createProductDeps>;
