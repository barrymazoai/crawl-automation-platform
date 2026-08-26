import fs from "node:fs/promises";
import { z } from "zod";

export const OcrResponseSchema = z.object({
  text: z.string(),
  lines: z.array(z.object({ text: z.string(), score: z.number(), polygon: z.unknown().optional() })).default([]),
});
export type OcrResponse = z.infer<typeof OcrResponseSchema>;

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
        if (!response.ok) throw new Error(`OCR HTTP ${response.status}`);
        return OcrResponseSchema.parse(await response.json());
      } catch (error) {
        lastError = error;
      } finally { clearTimeout(timer); }
    }
    throw lastError;
  }
}

