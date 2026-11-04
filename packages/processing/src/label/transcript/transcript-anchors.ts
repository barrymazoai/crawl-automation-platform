import type { EvidenceLine } from "../../text/protocol/evidence-lines.js";

/** A quote as the label-extraction/1 wire answer gives it: inclusive line ids and the printed words. */
export interface Anchor {
  fromLine: number;
  toLine: number;
  text: string;
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Locates copied text in the numbered source lines, in printed order, and remembers which lines were used. */
export class Anchors {
  private readonly used = new Set<number>();
  private cursor = 0;
  constructor(private readonly lines: EvidenceLine[]) {}

  /** The first line at or after `fromLine` (else the cursor) printing these words, quoted as printed. */
  find(value: string, fromLine?: number, unusedOnly = false): Anchor | null {
    const wanted = norm(value);
    const start = Math.max(0, fromLine !== undefined ? fromLine - 1 : this.cursor);
    const open = (line: EvidenceLine, at: number) =>
      at >= start && !(unusedOnly && this.used.has(line.id)) && !!wanted;
    // A cell is usually its own line: "Sodium" is that line, not the "sodium" inside "(as sodium selenate)".
    const whole = this.lines.findIndex((line, at) => open(line, at) && norm(line.text) === wanted);
    const index =
      whole >= 0
        ? whole
        : this.lines.findIndex(
            (line, at) => open(line, at) && printedSubstring(line.text, wanted) !== null,
          );
    const line = this.lines[index];
    const printed = line ? printedSubstring(line.text, wanted) : null;
    if (!line || printed === null) {
      return null;
    }
    this.used.add(line.id);
    if (fromLine === undefined) {
      this.cursor = index;
    }
    return { fromLine: line.id, toLine: line.id, text: printed };
  }

  /**
   * A row's value cell, printed after its name on a line no other field holds: null when the row has none,
   * undefined when it is not printed there.
   */
  value(value: string | null, name: Anchor): Anchor | null | undefined {
    if (!value) {
      return null;
    }
    return this.find(value, name.fromLine, true) ?? this.inLine(value, name) ?? undefined;
  }

  /** A value printed in the name's own line ("240 mcg Folic Acid", "Includes 4 g Added Sugars"). */
  private inLine(value: string, name: Anchor): Anchor | null {
    const line = this.lines.find((candidate) => candidate.id === name.fromLine);
    const printed = line ? printedSubstring(line.text, norm(value)) : null;
    return line && printed !== null ? { fromLine: line.id, toLine: line.id, text: printed } : null;
  }

  /** Gives a found line back, so it is left out (excluded) rather than quoted. */
  release(anchor: Anchor | null): void {
    if (anchor) {
      this.used.delete(anchor.fromLine);
    }
  }

  findHeading(pattern: RegExp): Anchor | null {
    for (const line of this.lines) {
      const match = pattern.exec(line.text.trim());
      if (match) {
        this.used.add(line.id);
        return { fromLine: line.id, toLine: line.id, text: match[0].trim() };
      }
    }
    return null;
  }

  /** The first and last line any field quotes. */
  usedRange(): { first: number; last: number } | null {
    const ids = [...this.used];
    return ids.length ? { first: Math.min(...ids), last: Math.max(...ids) } : null;
  }

  unused(): EvidenceLine[] {
    return this.lines.filter((line) => line.text.trim() && !this.used.has(line.id));
  }
}

/** The printed substring of `line` whose whitespace-normalized, case-folded form equals `wanted`. */
function printedSubstring(line: string, wanted: string): string | null {
  const lower = line.toLowerCase();
  const first = wanted.split(" ")[0] ?? "";
  for (let at = lower.indexOf(first); first && at >= 0; at = lower.indexOf(first, at + 1)) {
    for (let end = at + first.length; end <= line.length; end++) {
      const normalized = norm(line.slice(at, end));
      if (normalized === wanted) {
        return line.slice(at, end).trim();
      }
      if (normalized.length > wanted.length) {
        break;
      }
    }
  }
  return null;
}
