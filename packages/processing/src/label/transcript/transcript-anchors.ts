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
   * A row's value cell: printed after its name on the same line ("Biotin 10,000 mcg\t33,333%"), else as a whole
   * later line no other field holds (one cell per line), else inside the name's own line ("240 mcg Folic Acid",
   * "Includes 4 g Added Sugars"). Null when the row has none, undefined when it is not printed there.
   */
  value(value: string | null, name: Anchor): Anchor | null | undefined {
    if (!value) {
      return null;
    }
    const wanted = norm(value);
    const own = this.lines.find((line) => line.id === name.fromLine);
    return (
      (own && this.afterName(own, name, wanted)) ??
      this.wholeLaterLine(name, wanted) ??
      (own && quoted(own, printedSubstring(own.text, wanted))) ??
      undefined
    );
  }

  private afterName(own: EvidenceLine, name: Anchor, wanted: string): Anchor | null {
    const nameAt = own.text.toLowerCase().indexOf(name.text.toLowerCase());
    return nameAt < 0
      ? null
      : quoted(own, printedSubstring(own.text.slice(nameAt + name.text.length), wanted));
  }

  private wholeLaterLine(name: Anchor, wanted: string): Anchor | null {
    const cell = this.lines.find(
      (line) => line.id > name.fromLine && !this.used.has(line.id) && norm(line.text) === wanted,
    );
    if (!cell) {
      return null;
    }
    this.used.add(cell.id);
    return quoted(cell, cell.text.trim());
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

function quoted(line: EvidenceLine, text: string | null): Anchor | null {
  return text === null ? null : { fromLine: line.id, toLine: line.id, text };
}

/**
 * The printed substring of `line` whose whitespace-normalized, case-folded form equals `wanted`, on word boundaries:
 * "10" is never the start of "100 mg", "Zinc" never part of "Zincite".
 */
function printedSubstring(line: string, wanted: string): string | null {
  const lower = line.toLowerCase();
  const first = wanted.split(" ")[0] ?? "";
  for (let at = lower.indexOf(first); first && at >= 0; at = lower.indexOf(first, at + 1)) {
    if (WORD.test(lower[at - 1] ?? "") && WORD.test(first[0] ?? "")) {
      continue;
    }
    const found = spanFrom(line, at, wanted);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

const WORD = /[\p{L}\p{N}]/u;

/** The shortest span starting at `at` that reads as `wanted`, when the next character does not continue a word. */
function spanFrom(line: string, at: number, wanted: string): string | null {
  for (let end = at + 1; end <= line.length; end++) {
    const normalized = norm(line.slice(at, end));
    if (normalized === wanted) {
      const continues = WORD.test(line[end] ?? "") && WORD.test(wanted[wanted.length - 1] ?? "");
      return continues ? null : line.slice(at, end).trim();
    }
    if (normalized.length > wanted.length) {
      return null;
    }
  }
  return null;
}
