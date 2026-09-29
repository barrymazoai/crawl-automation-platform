import { Parser } from "htmlparser2";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import type { PagePrepareInput } from "@crawl-automation/v3-contracts";
import { PageCollector, type PageTable } from "./page-collector.js";
import { pageFailure } from "./page-errors.js";
import { pagePolicy } from "./page-input.js";

export interface ParsedPage {
  text: string;
  tables: PageTable[];
}

const normalize = (text: string) =>
  text
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function decodeHtml(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw pageFailure("PAGE.ENCODING", error);
  }
}

/**
 * The page's text and tables, read offline by htmlparser2: no scripts, resource loads or CSS, and no label
 * decisions. The bytes must be exactly the captured page.
 */
export function parsePage(
  input: PagePrepareInput,
  bytes: Uint8Array,
  signal: AbortSignal,
): ParsedPage {
  signal.throwIfAborted();
  verifyBytes(input.page, bytes, pagePolicy.maxBytes);
  const html = decodeHtml(bytes);
  const collector = new PageCollector();
  const parser = new Parser(
    {
      onopentag: (name, attributes) => collector.openTag(name, attributes),
      ontext: (value) => collector.text(value),
      onclosetag: (name) => collector.closeTag(name),
    },
    { decodeEntities: true, xmlMode: false },
  );
  parser.end(html);
  signal.throwIfAborted();
  const text = normalize(collector.parts.join(""));
  if (!text) {
    throw pageFailure("PROCESSING.PAGE_EMPTY");
  }
  for (const cell of collector.tables.flatMap((table) => table.rows.flat())) {
    cell.text = normalize(cell.text);
  }
  const tables = collector.tables;
  if (Buffer.byteLength(JSON.stringify({ text, tables })) > pagePolicy.maxOutputBytes) {
    throw pageFailure("PROCESSING.PAGE_LIMIT");
  }
  return { text, tables };
}
