import { describe, expect, it } from "vitest";
import { egoMessageAssembler, type EgoMessage } from "./ego-output.js";
import { EGO_MARKER } from "./ego-script.js";

async function assemble(lines: string[]) {
  const messages: EgoMessage[] = [];
  const assembler = egoMessageAssembler((message) => {
    messages.push(message);
  });
  for (const line of lines) {
    await assembler.line(line);
  }
  return { messages, failure: assembler.end() as { code?: string } | undefined };
}

const result = JSON.stringify({
  kind: "result",
  targetId: "t1",
  closed: true,
  failure: null,
  value: { html: "<html>" + "x".repeat(2_000) + "</html>" },
});

describe("Ego output assembly (lovewellness.com, 2026-10-21)", () => {
  it("reads whole marker lines and ignores the runtime's other output", async () => {
    const { messages, failure } = await assemble([
      "[ego-browser:notice] Ego Lite update is available (current 0.6.0.12).",
      `${EGO_MARKER}${JSON.stringify({ kind: "opened", targetId: "t1" })}`,
      "some runtime noise",
      `${EGO_MARKER}${result}`,
    ]);
    expect(failure).toBeUndefined();
    expect(messages.map((message) => message.kind)).toEqual(["opened", "result"]);
  });
  it("rejoins a result line that a CLI notice split in two", async () => {
    const cut = 700;
    const { messages, failure } = await assemble([
      `${EGO_MARKER}${result.slice(0, cut)}[ego-browser:notice] Ego Lite update is available (current 0.6.0.12). Finish the current browser task.`,
      result.slice(cut),
    ]);
    expect(failure).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("result");
  });
  it("rejoins a line split by a notice that stands on its own line", async () => {
    const cut = 1_200;
    const { messages, failure } = await assemble([
      `${EGO_MARKER}${result.slice(0, cut)}`,
      "[ego-browser:notice] Ego Lite update is available (current 0.6.0.12).",
      result.slice(cut),
    ]);
    expect(failure).toBeUndefined();
    expect(messages).toHaveLength(1);
  });
  it("still reports an unknown message and an unterminated fragment as protocol failures", async () => {
    const unknown = await assemble([`${EGO_MARKER}{"kind":"mystery"}`]);
    expect(unknown.failure?.code).toBe("BROWSER.PROTOCOL");
    const cut = await assemble([`${EGO_MARKER}${result.slice(0, 500)}`]);
    expect(cut.failure?.code).toBe("BROWSER.PROTOCOL");
    expect(cut.messages).toHaveLength(0);
  });
});
