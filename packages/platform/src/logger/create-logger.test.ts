import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./create-logger.js";

function captureLines(): { stream: Writable; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { stream, lines };
}

describe("createLogger", () => {
  it("writes JSON lines with the service name and child context", () => {
    const { stream, lines } = captureLines();
    const log = createLogger({ name: "api", destination: stream });

    log.child({ runId: "run-1" }).info({ productUrl: "https://example.com/p/1" }, "page captured");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      name: "api",
      runId: "run-1",
      productUrl: "https://example.com/p/1",
      msg: "page captured",
      level: 30,
    });
  });

  it("drops lines below the configured level", () => {
    const { stream, lines } = captureLines();
    const log = createLogger({ name: "worker", level: "warn", destination: stream });

    log.info("ignored");
    log.warn("kept");

    expect(lines.map((line) => line["msg"])).toEqual(["kept"]);
  });
});
