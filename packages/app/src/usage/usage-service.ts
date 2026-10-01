import { UsageWindowSchema, type UsageReader } from "./usage-model.js";

/** Read-only cost/time reporting. Unknown provider charges and token usage stay explicitly unknown. */
export class UsageService {
  constructor(private readonly reader: UsageReader) {}

  async summary(raw: unknown) {
    const window = UsageWindowSchema.parse(raw);
    return {
      window,
      basis: {
        interval: "[from,to)",
        products: "product runs accepted in window; each rerun counts separately",
        events: "calls and steps started in window, including failed calls",
        models: "client calls; internal provider requests and token counts may be unavailable",
        credits: "reported credits only; unknownCreditCalls are excluded from the sum",
        history: "measurements begin when migration 041 and instrumented workers are deployed",
      },
      ...(await this.reader.summarize(window)),
    };
  }
}
