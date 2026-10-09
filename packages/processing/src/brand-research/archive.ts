import { sha256 } from "@crawl-automation/platform";
import { z } from "zod";
import { checkedAnswer } from "./answer.js";
import { brandResearchErrors } from "./errors.js";
import { evidenceFile, PageReceiptSchema, type PageReceipt } from "./evidence-files.js";
import type { BrandResearchDeps } from "./settings.js";
import type { ResearchWorkspace } from "./workspace.js";

export interface RetainedPage extends PageReceipt {
  archiveKey: string;
  html: string;
}
export interface ResearchArchive {
  pages: RetainedPage[];
  archiveKeys: string[];
}

const diagnostics = [
  "request.json",
  "skills.json",
  "prompt.txt",
  "result.json",
  "events.jsonl",
  "stderr.txt",
  "process.json",
  "browser-preparation.jsonl",
  "pages.jsonl",
  "outcome.json",
];

/** Publication adapter: immutable local retention + R2 read-back are provided by RetainedPublication. */
export async function archiveWorkspace(
  publication: BrandResearchDeps["publication"],
  workspace: ResearchWorkspace,
  signal: AbortSignal,
): Promise<ResearchArchive> {
  const files = [];
  for (const name of diagnostics) {
    const bytes = await evidenceFile(workspace.cwd, name);
    if (bytes) {
      const file = {
        archiveKey: `${workspace.prefix}/records/${name}`,
        sha256: sha256(bytes),
        byteSize: bytes.length,
      };
      await publication.publish(file.archiveKey, bytes, "text/plain", signal);
      files.push(file);
    }
  }
  const pages = await archivePages(publication, workspace, signal);
  const manifestKey = `${workspace.prefix}/archive.json`;
  const manifest = { files, pages: pages.map(({ html: _html, ...page }) => page) };
  await publication.publish(
    manifestKey,
    Buffer.from(JSON.stringify(manifest)),
    "application/json",
    signal,
  );
  return {
    pages,
    archiveKeys: [
      ...pages.map((page) => page.archiveKey),
      ...files.map((file) => file.archiveKey),
      manifestKey,
    ],
  };
}

async function archivePages(
  publication: BrandResearchDeps["publication"],
  workspace: ResearchWorkspace,
  signal: AbortSignal,
) {
  const receipts = await readReceipts(workspace.cwd);
  const pages: RetainedPage[] = [];
  for (const receipt of receipts) {
    const bytes = await evidenceFile(workspace.cwd, receipt.path);
    if (!bytes || bytes.length !== receipt.byteSize || sha256(bytes) !== receipt.sha256) {
      throw brandResearchErrors.create("BRAND_RESEARCH.EVIDENCE_INVALID", {
        details: { path: receipt.path },
      });
    }
    const archiveKey = `${workspace.prefix}/pages/${receipt.sha256}.html`;
    await publication.publish(archiveKey, bytes, "text/html; charset=utf-8", signal);
    pages.push({ ...receipt, archiveKey, html: bytes.toString("utf8") });
  }
  return pages;
}

async function readReceipts(root: string): Promise<PageReceipt[]> {
  const bytes = await evidenceFile(root, "pages.jsonl");
  const receipts =
    bytes
      ?.toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => checkedAnswer(PageReceiptSchema, line, "page_receipt")) ?? [];
  const pages = checkedAnswer(z.array(PageReceiptSchema).max(200), receipts, "page_receipts");
  if (pages.reduce((total, page) => total + page.byteSize, 0) > 256 * 1024 * 1024) {
    throw brandResearchErrors.create("BRAND_RESEARCH.EVIDENCE_INVALID", {
      details: { reason: "evidence_limit" },
    });
  }
  return pages;
}
