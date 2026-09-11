import { Parser } from "htmlparser2";
import { PagePrepareInputSchema, type PagePrepareInput } from "@crawl-automation/v3-contracts";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import { AcquisitionError } from "./ports.js";
import { hash, verifyInput } from "./core.js";
export const PAGE_POLICY = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024, maxNodes: 100000, maxDepth: 128, maxTables: 200, maxCells: 20000 });
export const PAGE_CONFIG_FINGERPRINT = hash(JSON.stringify(["page.prepare/1", PAGE_POLICY]));
export type PageCell = {
    text: string;
    header: boolean;
    rowspan: number;
    colspan: number;
};
export type PageTable = {
    index: number;
    rows: PageCell[][];
};
export type PreparedPage = {
    input: PagePrepareInput;
    text: string;
    tables: PageTable[];
    artifactDurable: false;
    resultRegistered: false;
};
const omitted = new Set(["script", "style", "template", "noscript"]);
const blocks = new Set(["p", "div", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr", "td", "th", "table"]);
const normalize = (text: string) => text.replace(/[\t\r ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
/** Offline parser, not a browser/sanitizer. No scripts, resource loads, CSS or nutrition decisions. */
export function preparePage(raw: PagePrepareInput, rawBytes: Uint8Array, signal: AbortSignal): PreparedPage {
    const input = PagePrepareInputSchema.parse(raw);
    verifyInput(input, PAGE_CONFIG_FINGERPRINT);
    signal.throwIfAborted();
    const bytes = Buffer.from(rawBytes);
    verifyBytes(input.page, bytes, PAGE_POLICY.maxBytes);
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let depth = 0, suppressed = 0, nodes = 0, cells = 0, outputBytes = 0;
    const flags: boolean[] = [], text: string[] = [], tables: PageTable[] = [];
    const stack: {
        table: PageTable;
        row: PageCell[] | null;
        cell: PageCell | null;
    }[] = [];
    const append = (value: string) => {
        outputBytes += Buffer.byteLength(value) * (1 + stack.filter(t => t.cell).length);
        if (outputBytes > PAGE_POLICY.maxOutputBytes)
            throw new AcquisitionError("PROCESSING.PAGE_LIMIT");
        text.push(value);
        for (const t of stack)
            if (t.cell)
                t.cell.text += value;
    };
    const span = (raw: string | undefined) => {
        if (raw === undefined)
            return 1;
        if (!/^\d+$/.test(raw) || Number(raw) > 1000)
            throw new AcquisitionError("PROCESSING.PAGE_LIMIT");
        return Number(raw); // rowspan=0 means remaining rows, retained rather than guessed/expanded.
    };
    const parser = new Parser({
        onopentag(name, attrs) {
            if (++nodes > PAGE_POLICY.maxNodes || ++depth > PAGE_POLICY.maxDepth)
                throw new AcquisitionError("PROCESSING.PAGE_LIMIT");
            const skip = omitted.has(name);
            flags.push(skip);
            if (skip)
                suppressed++;
            if (suppressed)
                return;
            if (blocks.has(name))
                append("\n");
            if (name === "table") {
                if (tables.length >= PAGE_POLICY.maxTables)
                    throw new AcquisitionError("PROCESSING.PAGE_LIMIT");
                const table = { index: tables.length, rows: [] };
                tables.push(table);
                stack.push({ table, row: null, cell: null });
            }
            const current = stack.at(-1);
            if (name === "tr" && current) {
                current.row = [];
                current.table.rows.push(current.row);
                current.cell = null;
            }
            if ((name === "td" || name === "th") && current) {
                if (++cells > PAGE_POLICY.maxCells)
                    throw new AcquisitionError("PROCESSING.PAGE_LIMIT");
                if (!current.row) {
                    current.row = [];
                    current.table.rows.push(current.row);
                }
                current.cell = { text: "", header: name === "th", rowspan: span(attrs.rowspan), colspan: span(attrs.colspan) };
                current.row.push(current.cell);
            }
        },
        ontext(value) { if (++nodes > PAGE_POLICY.maxNodes)
            throw new AcquisitionError("PROCESSING.PAGE_LIMIT"); if (!suppressed)
            append(value); },
        onclosetag(name) {
            const skip = flags.pop();
            depth--;
            if (skip)
                suppressed--;
            if (suppressed || skip)
                return;
            const current = stack.at(-1);
            if ((name === "td" || name === "th") && current)
                current.cell = null;
            if (name === "tr" && current) {
                current.cell = null;
                current.row = null;
            }
            if (name === "table")
                stack.pop();
            if (blocks.has(name))
                append("\n");
        },
    }, { decodeEntities: true, xmlMode: false });
    parser.end(html);
    signal.throwIfAborted();
    const result = normalize(text.join(""));
    if (!result)
        throw new AcquisitionError("PROCESSING.PAGE_EMPTY");
    for (const table of tables)
        for (const row of table.rows)
            for (const cell of row)
                cell.text = normalize(cell.text);
    if (Buffer.byteLength(JSON.stringify({ text: result, tables })) > PAGE_POLICY.maxOutputBytes)
        throw new AcquisitionError("PROCESSING.PAGE_LIMIT");
    return { input, text: result, tables, artifactDurable: false, resultRegistered: false };
}
