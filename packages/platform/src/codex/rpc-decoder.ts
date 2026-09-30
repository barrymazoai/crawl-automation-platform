import { withCause } from "../errors/with-cause.js";
import { codexFailure } from "./errors.js";

/** The existing bounded newline/UTF-8 framing; no replacement wire protocol or buffering policy. */
export class RpcDecoder {
  private buffer = Buffer.alloc(0);
  private total = 0;

  constructor(
    private readonly receive: (message: unknown) => void,
    private readonly fail: (error: Error) => void,
  ) {}

  read(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.total > 8 * 1024 * 1024 || this.buffer.length + chunk.length > 2 * 1024 * 1024) {
      this.fail(codexFailure("TEXT.CODEX_OUTPUT_LIMIT"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      try {
        this.receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
      } catch (error) {
        this.fail(withCause(codexFailure("TEXT.CODEX_PROTOCOL"), error));
        break;
      }
    }
  }
}
