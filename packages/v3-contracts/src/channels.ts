import { z } from "zod";

/** Every channel the system knows. The one list; every layer imports it from here. */
export const CHANNEL_IDS = ["amazon", "gnc", "swanson", "dtc", "costco", "wholefoods"] as const;
export const ChannelIdSchema = z.enum(CHANNEL_IDS);
export type ChannelId = z.infer<typeof ChannelIdSchema>;
