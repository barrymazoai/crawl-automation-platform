import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readObservedProduct } from "./observed-product.mjs";
import { saveObservedDetails, verifyObservedDetails } from "./observed-details.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture(open = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "observed-details-"))); roots.push(root);
  const html = `<main><h1>Original title</h1><p id="brand">Actual brand</p><details ${open ? "open" : ""}><summary>Quality</summary><div id="quality"><p>Original quality statement.</p><table><caption>Original table</caption><tr><th>Column</th><td>Value</td></tr></table></div></details><img id="facts" src="https://test.example/facts.png"><aside id="other">Other product</aside></main>`;
  await writeFile(join(root,"page.html"), html); await writeFile(join(root,"screen.png"), "test screenshot");
  const method = { codec:"observed-product/1", productUrl:"https://test.example/products/one",
    sources:[{path:"page.html",url:"https://test.example/products/one",kind:"dom",sha256:createHash("sha256").update(html).digest("hex")}],
    fields:{ title:{source:0,selector:"h1"},brand:{source:0,selector:"#brand"},description:{source:0,selector:"#quality",format:"html"} } };
  const record = {...await readObservedProduct(root,method),gallery:[{url:"https://test.example/facts.png"}]};
  const base = {reason:"Inspected original and applicable location",evidence:["screen.png"],imageUrls:[]};
  const review = { version:"observed-details/1",checkScope:"website-text",reachedEnd:true,pageEvidence:["screen.png"],sections:[
    {...base,name:"Quality",status:"captured",field:"description",location:method.fields.description},
    {...base,name:"Facts image",status:"image-only",field:null,location:{source:0,selector:"#facts",attribute:"src"},imageUrls:["https://test.example/facts.png"]},
    {...base,name:"Other product",status:"excluded",field:null,location:{source:0,selector:"#other"}},
  ],checks:["description","ingredients","directions","warnings","facts"].map(kind=>({...base,kind,
    status:kind==="description"?"captured":kind==="facts"?"image-only":"not-present",
    fields:kind==="description"?["description"]:[],imageUrls:kind==="facts"?["https://test.example/facts.png"]:[],
  })) };
  return {root,method,record,review};
}

it("preserves the full selected HTML table and checked handoff without changing legacy raw semantics", async () => {
  const {root,method,record,review} = await fixture();
  expect(record.fields.description).toContain('<table><caption>Original table</caption>');
  expect(record.fields.description).toContain('<th>Column</th><td>Value</td>');
  const saved = await saveObservedDetails(root,record,review);
  expect(JSON.parse(await readFile(join(root,saved.detailCoveragePath),"utf8"))).toEqual(review);
  expect(await saveObservedDetails(root,record,review)).toEqual(saved);
  method.fields.description.format = "raw";
  expect((await readObservedProduct(root,method)).fields.description).not.toContain("<table>");
});

it("rejects a still-collapsed ancestor even though its text exists in saved HTML", async () => {
  const {root,record,review} = await fixture(false);
  await expect(verifyObservedDetails(root,record,review)).rejects.toThrow("section_not_expanded");
});

it("does not confuse absent website-text Facts with Facts images retained for the old pipeline", async () => {
  const {root,record,review} = await fixture();
  const facts = review.checks.find(check => check.kind === "facts");
  facts.status = "not-present";
  facts.imageUrls = [];
  facts.reason = "No website text or HTML Facts table; gallery is retained independently.";
  await expect(saveObservedDetails(root,record,review)).resolves.toMatchObject({passed:true});
  delete review.checkScope;
  await expect(saveObservedDetails(root,record,review)).rejects.toThrow("check_scope_required");
});

it.each(["missing-field","wrong-location","uninspected","missing-check","unretained-image","missing-evidence","changed-record","changed-source"])("blocks %s from a claimed complete handoff", async failure => {
  const {root,record,review} = await fixture();
  if (failure==="missing-field") review.sections[0].field="quality_not_handed_off";
  if (failure==="wrong-location") review.sections[0].location={source:0,selector:"#other"};
  if (failure==="uninspected") review.checks[1].status="uninspected";
  if (failure==="missing-check") review.checks.pop();
  if (failure==="unretained-image") record.gallery=[];
  if (failure==="missing-evidence") review.pageEvidence=["absent.png"];
  if (failure==="changed-record") record.fields.description="invented quality";
  if (failure==="changed-source") await writeFile(join(root,"page.html"),"replaced");
  await expect(verifyObservedDetails(root,record,review)).rejects.toThrow();
});
