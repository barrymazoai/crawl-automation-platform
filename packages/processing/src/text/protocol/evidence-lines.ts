import type { TextInput } from "@crawl-automation/v3-contracts";

/** One numbered line of the selected text; ids start at 1 within the range, offsets are absolute. */
export interface EvidenceLine {
  id: number;
  text: string;
  start: number;
  end: number;
}

/** A located quote: the exact printed substring and its absolute offsets. */
export interface Quote {
  text: string;
  start: number;
  end: number;
}

export type Span = Pick<Quote, "start" | "end">;

/** The selected range as numbered lines, which is how the model sees it and cites it. */
export function evidenceLines(input: Pick<TextInput, "range">, text: string): EvidenceLine[] {
  let offset = input.range.start;
  return text
    .slice(input.range.start, input.range.end)
    .split("\n")
    .map((value, index) => {
      const line = { id: index + 1, text: value, start: offset, end: offset + value.length };
      offset += value.length + 1;
      return line;
    });
}
