import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Where the Ego browser runs: its command-line runtime and the one task space the crawler owns in it. Read once at
 * startup from the machine's private config.
 */
export const EgoSettingsSchema = z.strictObject({
  /** The `ego-browser` executable, e.g. `/Users/<user>/.local/bin/ego-browser`. */
  cliPath: z.string().refine(isAbsolute, "an absolute path"),
  /** The task space the crawler owns; pages are opened and closed inside it only. */
  taskSpaceId: z.number().int().positive(),
  /** The longest one browser round may take, page load and scrolling included. */
  roundTimeoutMs: z.number().int().min(5_000).max(900_000).default(180_000),
  /** The largest page HTML a round may hand back. */
  maxHtmlBytes: z.number().int().min(1_024).max(16_777_216).default(8_388_608),
});
export type EgoSettings = z.output<typeof EgoSettingsSchema>;
