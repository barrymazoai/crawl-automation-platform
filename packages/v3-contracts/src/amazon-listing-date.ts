import { z } from "zod";

/** A calendar date, never a capture/first-seen timestamp. Null date preserves unrecognised wording. */
export const AmazonListingDateSchema = z.strictObject({
  date: z.iso.date().nullable(),
  rawText: z.string(),
  selector: z.enum(["#detailBullets_feature_div li", "#prodDetails tr"]),
});
export type AmazonListingDate = z.infer<typeof AmazonListingDateSchema>;
