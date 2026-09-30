import fs from "node:fs/promises";
import { z } from "zod";

export const OcrResponseSchema = z.object({
  text: z.string(),
  lines: z.array(z.object({ text: z.string(), score: z.number(), polygon: z.unknown().optional() })).default([]),
});
export type OcrResponse = z.infer<typeof OcrResponseSchema>;

/** OCR 服务明确拒绝了这张图（4xx），换多少次都一样，调用方应当跳过而不是重试。 */
export class OcrRejectedError extends Error {
  constructor(readonly status: number, readonly filename: string) {
    super(`OCR HTTP ${status}`);
    this.name = "OcrRejectedError";
  }
}

export class OcrClient {
  constructor(private options: { endpoint: string; timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch }) {}
  async recognize(filename: string): Promise<OcrResponse> {
    const retries = this.options.retries ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
      try {
        const form = new FormData();
        const data = await fs.readFile(filename);
        form.append("file", new Blob([data]), filename.split(/[\\/]/).at(-1));
        const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint, { method: "POST", body: form, signal: controller.signal });
        // 4xx 是这张图本身的问题（格式不支持、内容不合法），重试只是白跑一遍。
        if (response.status >= 400 && response.status < 500) throw new OcrRejectedError(response.status, filename);
        if (!response.ok) throw new Error(`OCR HTTP ${response.status}`);
        return OcrResponseSchema.parse(await response.json());
      } catch (error) {
        if (error instanceof OcrRejectedError) throw error;
        lastError = error;
      } finally { clearTimeout(timer); }
    }
    throw lastError;
  }
}

