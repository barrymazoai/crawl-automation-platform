import { describe, expect, it } from "vitest";
import { savedEvidence } from "./saved-evidence.js";
import { replayText, textTotals } from "./text-answers.js";
import { replayAssemblies } from "./assembly-decisions.js";

const directory = process.env.REVIEWS_0930_DIR;

describe.skipIf(!directory)("saved label evidence replay (no model calls)", () => {
  it("reports decoded answers and counterfactual assembly decisions by final product reason", async () => {
    if (!directory) {
      return;
    }
    const data = savedEvidence(directory);
    const answers = replayText(data);
    const decisions = await replayAssemblies(data, answers);
    const byRun = new Map(decisions.map((decision) => [decision.runId, decision]));
    const products: Record<
      string,
      { beforeReview: number; replayed: number; nowReady: number; afterReview: number }
    > = {};
    const recovered: string[] = [];
    for (const item of data.queue.filter((item) => item.state === "review")) {
      const count = (products[item.reason ?? "unspecified"] ??= {
        beforeReview: 0,
        replayed: 0,
        nowReady: 0,
        afterReview: 0,
      });
      count.beforeReview++;
      const decision = byRun.get(item.runId);
      if (decision) {
        count.replayed++;
      }
      if (decision && !decision.after.length) {
        count.nowReady++;
        recovered.push(item.listingId);
      } else {
        count.afterReview++;
      }
    }
    const summary = {
      textAnswers: answers.size,
      text: textTotals(answers),
      assemblyCandidates: decisions.length,
      products,
      productsNowReady: recovered.length,
      limitation:
        "Counterfactual readiness only. Saved registrations are trusted for decision replay; image bytes cannot be reverified here. Promoted text has no new receipts. Nothing was collected.",
      recovered,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    expect(answers.size).toBe(670);
    expect(decisions.length).toBe(619);
    expect(recovered.length).toBeGreaterThan(0);
  }, 60000);
});
