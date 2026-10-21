import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { z } from "zod";
import { egoErrors } from "./ego-errors.js";
import { EGO_MARKER } from "./ego-script.js";
import { EgoSettingsSchema, type EgoSettings } from "./ego-settings.js";

export const EgoFailureSchema = z.object({
  name: z.string(),
  code: z.string().nullable(),
  message: z.string().optional(),
});

const MessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("health"),
    code: z.string().nullable(),
    targets: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("space"),
    spaceId: z.number().int().positive().nullable(),
    ownership: z.string().nullable(),
    code: z.string().nullable(),
  }),
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
  timeoutMs?: number | undefined;
  opened?: (targetId: string) => Promise<void>;
}

/**
 * Ego 0.5.0 runs a script inside an async function; 0.5.1 runs it as a module, where a top-level `return` is a
 * syntax error (seen on Server 二, 2026-10-02). Our scripts return early, so each runs as one named async function.
 * A leading `await (…)` would not do: plain-script parsing reads it as a call to a function named `await`.
 */
export function egoProgram(script: string): string {
  return `async function crawlerRound() {\n${script}\n}\nawait crawlerRound();\n`;
}

/** Reads opened targets while the runtime is still running, so worker loss retains ownership. */
export async function executeEgoScript(settings: EgoSettings, options: CommandOptions) {
  const config = EgoSettingsSchema.parse(settings);
  const subprocess = execa(config.cliPath, ["nodejs"], {
    input: egoProgram(options.script),
    cancelSignal: options.signal,
    timeout: options.timeoutMs ?? config.roundTimeoutMs,
    all: true,
    maxBuffer: config.maxHtmlBytes * 2 + 65_536,
    forceKillAfterDelay: config.killGraceMs,
    // Ego is already running outside this group; only this CLI and its request-runtime children die.
    killDescendants: true,
    reject: false,
  });
  // The CLI relays the script's console lines on stderr and writes its own output on stdout; each stream is read
  // on its own so one cannot splice into the other's lines.
  const output = collectMessages([subprocess.stderr, subprocess.stdout], options.opened);
  const [answer, captured] = await Promise.all([subprocess, output]);
  return { answer, pid: subprocess.pid, ...captured };
}

/** A CLI notice the Ego runtime prints asynchronously, e.g. `[ego-browser:notice] Ego Lite update is available…`. */
const CLI_NOTICE = /\[ego-browser:[a-z]+\][^\n]*$/u;

/**
 * Assembles marker messages from output lines. A notice the CLI prints while a long line is still being written
 * splits that line in two (a 1 MB page ended "Unterminated string in JSON at position 579148", lovewellness.com,
 * 2026-10-21): the fragment keeps waiting for its continuation lines, with the notice text removed, until the JSON
 * parses. A line that parses but is not a known message is still a protocol failure.
 */
export function egoMessageAssembler(onMessage: (message: EgoMessage) => void | Promise<void>) {
  return new EgoMessageAssembler(onMessage);
}

class EgoMessageAssembler {
  private pending: string | null = null;
  private failure: unknown;

  constructor(private readonly onMessage: (message: EgoMessage) => void | Promise<void>) {}

  async line(raw: string): Promise<void> {
    const line = raw.replace(CLI_NOTICE, "");
    if (line.startsWith(EGO_MARKER)) {
      this.unterminated();
      this.pending = line.slice(EGO_MARKER.length);
    } else if (this.pending !== null) {
      this.pending += line;
    } else {
      return;
    }
    await this.settle();
  }

  /** The failure, if any, once the stream has ended. */
  end(): unknown {
    this.unterminated();
    return this.failure;
  }

  private fail(cause: unknown): void {
    this.failure ??= egoErrors.create("BROWSER.PROTOCOL", { cause });
  }

  private unterminated(): void {
    if (this.pending !== null) {
      this.fail(new Error(`Unterminated Ego message: ${this.pending.slice(0, 200)}`));
      this.pending = null;
    }
  }

  private async settle(): Promise<void> {
    if (this.pending === null) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.pending);
    } catch {
      return; // A split line: wait for the rest.
    }
    const text = this.pending;
    this.pending = null;
    const message = MessageSchema.safeParse(parsed);
    if (!message.success) {
      this.fail(new Error(`Unknown Ego message: ${text.slice(0, 200)}`));
      return;
    }
    await this.onMessage(message.data);
  }
}

async function collectMessages(
  streams: (Readable | null | undefined)[],
  opened?: (targetId: string) => Promise<void>,
) {
  const messages: EgoMessage[] = [];
  let failure: unknown;
  const read = async (stream: Readable) => {
    const assembler = egoMessageAssembler(async (message) => {
      messages.push(message);
      if (message.kind === "opened") {
        await opened?.(message.targetId);
      }
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      await assembler.line(line);
    }
    failure ??= assembler.end();
  };
  await Promise.all(streams.flatMap((stream) => (stream ? [read(stream)] : [])));
  return { messages, failure };
}
