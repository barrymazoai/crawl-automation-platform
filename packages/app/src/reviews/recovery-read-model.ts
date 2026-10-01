import { z } from "zod";
import type { ReviewRecoveryService } from "./recovery-service.js";

const Page = z
  .object({ items: z.array(z.object({ reviewId: z.string() }).passthrough()) })
  .passthrough();

/** Immutable Review history with its companion recovery status, without rewriting the old failure. */
export async function recoveredReviewPage(raw: unknown, recovery: ReviewRecoveryService) {
  const page = Page.parse(raw);
  const items = await Promise.all(
    page.items.map(async (item) => ({
      ...item,
      recovery: await recovery.status(item.reviewId),
    })),
  );
  return { ...page, items };
}
