import { execa } from "execa";
import { z } from "zod";
import { egoErrors } from "./ego-errors.js";
import { EGO_MARKER } from "./ego-script.js";
import type { EgoSettings } from "./ego-settings.js";

const FailureSchema = z.object({ name: z.string(), code: z.string().nullable() });

const MessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop"), reason: z.literal("user-control") }),
  z.object({ kind: z.literal("opened"), targetId: z.string().min(1) }),
  z.object({
    kind: z.literal("result"),
    targetId: z.string().min(1),
    closed: z.boolean(),
    failure: FailureSchema.nullable(),
    value: z.unknown(),
  }),
]);
type Message = z.infer<typeof MessageSchema>;
type RoundResult = Extract<Message, { kind: "result" }>;

/** What a round's script threw, by its own name and code. */
export type EgoRoundFailure = z.infer<typeof FailureSchema>;

/** Runs one Ego round script and reads its marked messages. */
export class EgoRunner {
  constructor(private readonly settings: EgoSettings) {}

  /** The round's result. Refuses a user stop, a lost page, a failed or unfinished round, each by its own code. */
  async run(script: string, signal: AbortSignal): Promise<RoundResult> {
    const answer = await execa(this.settings.cliPath, ["nodejs"], {
      input: script,
      cancelSignal: signal,
      timeout: this.settings.roundTimeoutMs,
      maxBuffer: { stdout: this.settings.maxHtmlBytes * 2 + 65_536, stderr: 1_048_576 },
      forceKillAfterDelay: 5_000,
      reject: false,
    });
    const messages = readMessages(answer.stdout);
    const opened = messages
      .filter((message) => message.kind === "opened")
      .map((message) => message.targetId);
    if (messages.some((message) => message.kind === "stop")) {
      throw egoErrors.create("BROWSER.USER_CONTROL");
    }
    const result = messages.find((message): message is RoundResult => message.kind === "result");
    if (!result) {
      throw roundFailure(answer, opened);
    }
    if (!result.closed) {
      throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
        details: { targetId: result.targetId },
      });
    }
    return result;
  }
}

interface ExecaAnswer {
  isCanceled: boolean;
  timedOut: boolean;
  isMaxBuffer: boolean;
  exitCode?: number | undefined;
}

/** A round that ended without its result: a page it opened may still be open, so cleanup is pending for it. */
function roundFailure(answer: ExecaAnswer, opened: readonly string[]) {
  const details = { exitCode: answer.exitCode ?? null, opened };
  if (opened.length > 0) {
    return egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", { details });
  }
  if (answer.isCanceled) {
    return egoErrors.create("BROWSER.CANCELLED", { details });
  }
  if (answer.timedOut) {
    return egoErrors.create("BROWSER.TIMEOUT", { details });
  }
  if (answer.isMaxBuffer) {
    return egoErrors.create("BROWSER.PAGE_LIMIT", { details });
  }
  return egoErrors.create("BROWSER.UNAVAILABLE", { details });
}

function readMessages(output: unknown): Message[] {
  const text = typeof output === "string" ? output : "";
  const messages: Message[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(EGO_MARKER)) {
      continue;
    }
    const parsed = MessageSchema.safeParse(parseJson(line.slice(EGO_MARKER.length)));
    if (!parsed.success) {
      throw egoErrors.create("BROWSER.PROTOCOL", { cause: parsed.error });
    }
    messages.push(parsed.data);
  }
  return messages;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw egoErrors.create("BROWSER.PROTOCOL", { cause: error });
  }
}
