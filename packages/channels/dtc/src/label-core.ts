import {
  labelCoreFailure,
  labelRange,
  pageText,
  type LabelCoreReader,
} from "@crawl-automation/channels-core";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200_000;

/**
 * Owner 2026-10-20 (bloodsugarfriendly.com): a DTC page's label text is its Facts panel and the ingredient statement
 * after it, with div-built cells kept apart. Given the whole page (640 lines, the panel printed three times), the
 * label text model failed 46 of 46 runs on every model; given this, Luna medium read 7 of 10, all values right. A
 * page without a panel whose end is known keeps its whole text.
 */
export function extractDtcLabelCore(html: string): string {
  if (Buffer.byteLength(html) > MAX_BYTES) {
    throw labelCoreFailure("LABEL_CORE.SOURCE_LIMIT");
  }
  const text = pageText(html, { rowCells: true });
  const range = labelRange(text);
  const core = range ? text.slice(range.start, range.end) : text;
  if (core.length > MAX_TEXT_LENGTH) {
    throw labelCoreFailure("LABEL_CORE.OUTPUT_LIMIT");
  }
  return core;
}

/** DTC's label-core reader, for pages the shared product pipeline produced (as Swanson's are). */
export const dtcLabelCore: LabelCoreReader = {
  sourceModule: "channel.product-input",
  sourceVersion: "channel-plan/1",
  extract: extractDtcLabelCore,
};
