import type { OcrLine } from "../../keywords/ocr-text.js";

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * One printed line: the OCR boxes whose heights overlap, left to right. The OCR splits a line into pieces ("0.65" |
 * "mg", "Folate" | "[from" | "Quatrefolic®"); a row's name may start at any piece (a second printed column).
 */
export interface Visual {
  text: string;
  /** Where each character sits along the line, and the height of its own piece's middle. */
  xs: number[];
  ys: number[];
  /** Where each piece starts in the text, and its box. */
  pieces: { at: number; box: Box }[];
  top: number;
  bottom: number;
}

function box(polygon: readonly (readonly [number, number])[]): Box {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** A box this many times taller than the image's usual line is rotated text (a side panel), never a row's line. */
const TALL = 2.5;

/** The OCR boxes grouped into printed lines (heights overlapping by half), each read left to right. */
export function visualLines(lines: readonly OcrLine[]): Visual[] {
  const all = lines.flatMap((line) =>
    line.polygon?.length === 4 ? [{ text: line.text, box: box(line.polygon) }] : [],
  );
  const heights = all
    .map((piece) => piece.box.bottom - piece.box.top)
    .sort((low, high) => low - high);
  const usual = heights[Math.floor(heights.length / 2)] ?? 0;
  const boxes = all
    .filter((piece) => piece.box.bottom - piece.box.top <= TALL * usual)
    .sort((upper, lower) => upper.box.top + upper.box.bottom - lower.box.top - lower.box.bottom);
  const groups: { top: number; bottom: number; members: typeof boxes }[] = [];
  for (const piece of boxes) {
    const height = piece.box.bottom - piece.box.top;
    const group = groups.find((line) => {
      const overlap = Math.min(line.bottom, piece.box.bottom) - Math.max(line.top, piece.box.top);
      return overlap >= Math.min(height, line.bottom - line.top) / 2;
    });
    if (group) {
      group.members.push(piece);
    } else {
      groups.push({ top: piece.box.top, bottom: piece.box.bottom, members: [piece] });
    }
  }
  return groups.map((group) =>
    joined(group.members.sort((left, right) => left.box.left - right.box.left)),
  );
}

function joined(members: readonly { text: string; box: Box }[]): Visual {
  const line: Visual = { text: "", xs: [], ys: [], pieces: [], top: Infinity, bottom: -Infinity };
  for (const { text, box: at } of members) {
    if (line.text) {
      line.text += " ";
      line.xs.push(at.left);
      line.ys.push((at.top + at.bottom) / 2);
    }
    line.pieces.push({ at: line.text.length, box: at });
    const width = at.right - at.left;
    [...text].forEach((_, index) => {
      line.xs.push(at.left + (width * (index + 0.5)) / Math.max(1, text.length));
      line.ys.push((at.top + at.bottom) / 2);
    });
    line.text += [...text].join("");
    line.top = Math.min(line.top, at.top);
    line.bottom = Math.max(line.bottom, at.bottom);
  }
  return line;
}
