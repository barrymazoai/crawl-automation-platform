import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { readObservedProduct, inspectObservedField } from "./observed-product.mjs";

const fail = reason => { throw new Error(`DTC.DETAIL_COVERAGE:${reason}`); };
const text = value => typeof value === "string" && value.trim();
const list = value => Array.isArray(value) && value.every(text);
const kinds = ["description", "ingredients", "directions", "warnings", "facts"];

/** Verify the model's section inventory and handoff, not discover or classify sections. */
export async function verifyObservedDetails(root, record, review) {
  if (review?.version !== "observed-details/1" || !list(review.pageEvidence)
      || !review.pageEvidence.length || review.reachedEnd !== true
      || !Array.isArray(review.sections) || !review.sections.length
      || !Array.isArray(review.checks) || review.checks.length !== kinds.length) fail("review_required");
  const evidence = new Set(review.pageEvidence);
  const images = new Set((record.gallery ?? []).map(image => image.url));
  const observed = await readObservedProduct(root, record.fieldEvidence);
  const fields = { ...record.fields }; delete fields.images;
  if (!isDeepStrictEqual(fields, observed.fields)) fail("record_changed");
  const included = new Set();
  const includedImages = new Set();
  for (const section of review.sections) {
    checkEntry(section, evidence);
    if (!text(section.name) || !["captured", "image-only", "excluded"].includes(section.status)) fail("section_uninspected");
    const actual = await inspectObservedField(root, record.fieldEvidence, section.location);
    if (section.status !== "excluded" && actual.collapsed) fail("section_not_expanded");
    if (section.status === "captured") {
      if (!text(section.field) || !Object.hasOwn(observed.fields, section.field)
          || !isDeepStrictEqual(record.fieldEvidence.fields[section.field], section.location)) fail("section_not_handed_off");
      included.add(section.field);
    } else if (section.field !== null) fail("unexpected_section_field");
    if (section.status === "image-only" && !section.imageUrls.length) fail("section_image_missing");
    if (section.status === "excluded" && section.imageUrls.length) fail("excluded_image_handoff");
    for (const url of section.imageUrls) {
      if (!images.has(url)) fail("unretained_image");
      includedImages.add(url);
    }
  }
  const seen = new Set();
  for (const check of review.checks) {
    checkEntry(check, evidence);
    if (!kinds.includes(check.kind) || seen.has(check.kind) || !list(check.fields)) fail("check_identity");
    seen.add(check.kind);
    if (check.status === "captured") {
      if (!check.fields.length || check.fields.some(field => !included.has(field))) fail("check_not_handed_off");
    } else if (check.status === "image-only") {
      if (check.fields.length || !check.imageUrls.length) fail("check_image_missing");
    } else if (check.status === "not-present") {
      if (check.fields.length || check.imageUrls.length) fail("absent_has_content");
    } else fail("check_uninspected");
    if (check.imageUrls.some(url => !includedImages.has(url))) fail("check_image_uninspected");
  }
  for (const path of evidence) await localFile(root, path);
  return { evidence: [...evidence], fields: [...included], imageUrls: [...includedImages] };
}

function checkEntry(entry, evidence) {
  if (!text(entry.reason) || !list(entry.evidence) || !entry.evidence.length || !list(entry.imageUrls)) fail("entry_evidence");
  for (const path of entry.evidence) evidence.add(path);
}

async function localFile(root, path) {
  const full = resolve(root, path), local = relative(resolve(root), full);
  if (!local || local.startsWith("..") || isAbsolute(local) || await realpath(full) !== full) fail("evidence_path");
  await readFile(full);
}

/** Save the checked proof intact; final capture review references this path without copying fields. */
export async function saveObservedDetails(root, record, review) {
  await verifyObservedDetails(root, record, review);
  const bytes = JSON.stringify(review, null, 2);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = `methods/details-${digest}.json`;
  await mkdir(join(root, "methods"), { recursive: true });
  try { await writeFile(join(root, path), bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || await readFile(join(root, path), "utf8") !== bytes) throw error;
  }
  return { detailCoveragePath: path, passed: true };
}
