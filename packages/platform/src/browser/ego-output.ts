import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { z } from "zod";
import { egoErrors } from "./ego-errors.js";
import { EGO_MARKER } from "./ego-script.js";
import type { EgoSettings } from "./ego-settings.js";

export const EgoFailureSchema = z.object({
  name: z.string(),
  code: z.string().nullable(),
  message: z.string().optional(),
});

const MessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop"), reason: z.literal("user-control") }),
  z.object({ kind: z.literal("opened"), targetId: z.string().min(1) }),
  z.object({
    kind: z.literal("result"),
    targetId: z.string().min(1),
    closed: z.boolean(),
    failure: EgoFailureSchema.nullable(),
    cleanupFailure: EgoFailureSchema.nullable().optional(),
    value: z.unknown(),
  }),
]);
export type EgoMessage = z.infer<typeof MessageSchema>;
export type EgoRoundResult = Extract<EgoMessage, { kind: "result" }>;
export type EgoRoundFailure = z.infer<typeof EgoFailureSchema>;

interface CommandOptions {
  script: string;
  signal: AbortSignal;
  opened?: (targetId: string) => Promise<void>;
}

/** Reads opened targets while the runtime is still running, so worker loss retains ownership. */
export async function executeEgoScript(settings: EgoSettings, options: CommandOptions) {
  const subprocess = execa(settings.cliPath, ["nodejs"], {
    input: options.script,
    cancelSignal: options.signal,
    timeout: settings.roundTimeoutMs,
    all: true,
    maxBuffer: settings.maxHtmlBytes * 2 + 65_536,
    forceKillAfterDelay: 5_000,
    reject: false,
  });
  const output = collectMessages(subprocess.all, options.opened);
  const [answer, captured] = await Promise.all([subprocess, output]);
  return { answer, ...captured };
}

async function collectMessages(stream: Readable, opened?: (targetId: string) => Promise<void>) {
  const messages: EgoMessage[] = [];
  let failure: unknown;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith(EGO_MARKER)) {
      continue;
    }
    try {
      const message = MessageSchema.parse(JSON.parse(line.slice(EGO_MARKER.length)));
      messages.push(message);
      if (message.kind === "opened") {
        await opened?.(message.targetId);
      }
    } catch (error) {
      failure ??= egoErrors.create("BROWSER.PROTOCOL", { cause: error });
    }
  }
  return { messages, failure };
}
