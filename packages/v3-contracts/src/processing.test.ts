import { describe, expect, it, vi } from "vitest";
import { ArtifactRefSchema, ObjectKeySchema, assertArtifactBelongsTo } from "./artifacts.js";
import { CompletionSchema, OcrInputSchema, OcrOutputSchema, OcrReuseRecordSchema, ReviewSchema, assertOcrCompatibility, assertProcessingResultMatches,
  fingerprintOcrInput, ocrFingerprintMaterial, parseOcrInput, processingIdentity, type OcrInput } from "./processing.js";

// Deliberately no Node crypto in this package, including tests. Digest callback
// behavior is checked here; actual SHA-256 vectors are checked by pilot runtime.
const digest = (_material: string) => "f".repeat(64);
function fixture(): OcrInput {
  return { schemaVersion: 1, module: "ocr.file", requestId: "req-1", observationId: "obs-1", operationId: "ocr-1",
    brandId: "brand-1", sourceId: "source-1", listingId: "listing-1", variantId: null,
    implementationVersion: "ocr/1", policyVersion: "evidence/1", resultSchemaVersion: 1, configFingerprint: "c".repeat(64),
    inputFingerprint: "f".repeat(64), file: { schemaVersion: 1, artifactId: "artifact-1", observationId: "obs-1",
      sourceId: "source-1", listingId: "listing-1", variantId: null, kind: "source-image", mediaType: "image/png",
      sha256: "a".repeat(64), byteSize: 100, objectKey: "sources/image.png",
      producer: { operationId: "capture-1", module: "capture", implementationVersion: "capture/1" } } };
}
describe("V3 shared processing boundary", () => {
  it("v2 requires provider evidence, preserves metadata and cannot reuse text-only v1 results", () => {
    const input = { ...fixture(), resultSchemaVersion: 2 as const };
    const rawResponse = { text: " raw text ", lines: [{ text: "raw text", score: 0.98, polygon: [[0, 0], [5, 0], [5, 2], [0, 2]] }], request_id: "synthetic", detector: "test" };
    const output = { ...processingIdentity(input), provider: "test/2", text: rawResponse.text, rawResponse };
    expect(OcrOutputSchema.parse(output)).toEqual(output);
    expect(() => assertProcessingResultMatches(input, output, "output")).not.toThrow();
    const { rawResponse: _removed, ...textOnly } = output;
    expect(OcrOutputSchema.safeParse(textOnly).success).toBe(false);
    expect(() => assertProcessingResultMatches(input, { ...textOnly, resultSchemaVersion: 1 }, "output")).toThrow();
    expect(OcrOutputSchema.safeParse({ ...output, text: "rewritten" }).success).toBe(false);
    expect(() => assertOcrCompatibility(input, { module: input.module, schemaVersion: input.schemaVersion,
      implementationVersion: input.implementationVersion, policyVersion: input.policyVersion,
      configFingerprint: input.configFingerprint, resultSchemaVersion: 1 })).toThrow("INCOMPATIBLE_CONSUMER:resultSchemaVersion");
    expect(ocrFingerprintMaterial(input)).not.toBe(ocrFingerprintMaterial(fixture()));
  });
  it("parses and canonicalizes without Node globals, clocks or random identity creation",()=>{
    const i=fixture();
    vi.stubGlobal("Buffer",undefined);vi.stubGlobal("process",undefined);vi.stubGlobal("crypto",undefined);
    try { expect(parseOcrInput(i,digest)).toEqual(i); expect(ocrFingerprintMaterial(i)).toContain("v3:ocr-input:1"); }
    finally { vi.unstubAllGlobals(); }
  });
  it("A01: accepts one image; rejects batch fields, PDFs and arbitrary payload", () => {
    const i = fixture(); expect(OcrInputSchema.parse(i)).toEqual(i);
    for (const value of [{...i,file:[i.file]}, {...i,files:[i.file]}, {...i,token:"secret"},
      {...i,file:{...i.file,kind:"source-pdf",mediaType:"application/pdf"}}]) expect(OcrInputSchema.safeParse(value).success).toBe(false);
  });
  it("validates PDF-page lineage and actual declared media kind", () => {
    const i = fixture(), page = {...i.file,kind:"pdf-page",parentArtifactId:"pdf-1",pageIndex:0};
    expect(OcrInputSchema.safeParse({...i,file:page}).success).toBe(true);
    for (const file of [{...page,parentArtifactId:i.file.artifactId},{...page,pageIndex:-1},{...page,parentArtifactId:undefined},
      {...i.file,mediaType:"application/pdf"},{...i.file,pageIndex:0}]) expect(ArtifactRefSchema.safeParse(file).success).toBe(false);
  });
  it("rejects source, listing, observation and variant cross-wiring", () => {
    const i=fixture(); const owner={schemaVersion:1 as const,requestId:i.requestId,observationId:i.observationId,brandId:i.brandId,sourceId:i.sourceId,listingId:i.listingId,variantId:i.variantId};
    for(const field of ["sourceId","observationId","listingId","variantId"] as const){
      const file={...i.file,[field]:"other"}; expect(()=>assertArtifactBelongsTo(file,owner)).toThrow();
      expect(OcrInputSchema.safeParse({...i,file}).success).toBe(false);
    }
  });
  it.each(["/tmp/image.png","C:\\files\\image.png","https://r2.example/x?signature=secret","file:///tmp/x","../secret","sources/../secret","sources/./x","sources//x","sources/x?token=secret","sources/%2e%2e/x"])("does not accept a path or signed URL as objectKey: %s", key=>{
    expect(ObjectKeySchema.safeParse(key).success).toBe(false);
  });
  it("bounds references and disallows unsafe IDs or unsupported versions",()=>{
    const i=fixture();
    for(const value of [{...i,schemaVersion:2},{...i,resultSchemaVersion:3},{...i,operationId:"https://site/p"},
      {...i,file:{...i.file,byteSize:0}},{...i,file:{...i.file,byteSize:Number.MAX_SAFE_INTEGER+1}},
      {...i,file:{...i.file,sha256:"bad"}},{...i,file:{...i.file,localPath:"/tmp/image"}}]) expect(OcrInputSchema.safeParse(value).success).toBe(false);
  });
  it("canonical material is ordered, location independent and includes versions/content/lineage",()=>{
    const i=fixture(), baseline=ocrFingerprintMaterial(i);
    const reordered=Object.fromEntries(Object.entries(i).reverse()) as OcrInput;
    expect(ocrFingerprintMaterial(reordered)).toBe(baseline);
    expect(ocrFingerprintMaterial({...i,file:{...i.file,objectKey:"moved/image.png"}})).toBe(baseline);
    for(const field of ["requestId","operationId","brandId","implementationVersion","policyVersion","configFingerprint"] as const){
      const value=field==="configFingerprint"?"d".repeat(64):"new-value";
      expect(ocrFingerprintMaterial({...i,[field]:value})).not.toBe(baseline);
    }
    expect(ocrFingerprintMaterial({...i,file:{...i.file,sha256:"b".repeat(64)}})).not.toBe(baseline);
    expect(ocrFingerprintMaterial({...i,file:{...i.file,producer:{...i.file.producer,implementationVersion:"capture/2"}}})).not.toBe(baseline);
  });
  it("A24: a new observation of identical bytes has a new fingerprint material",()=>{
    const i=fixture(), next={...i,requestId:"req-2",operationId:"ocr-2",observationId:"obs-2",file:{...i.file,observationId:"obs-2",artifactId:"artifact-2"}};
    expect(ocrFingerprintMaterial(next)).not.toBe(ocrFingerprintMaterial(i));
  });
  it("verifies supplied digest and rejects a malformed hash adapter",()=>{
    const i=fixture(); expect(parseOcrInput(i,digest)).toEqual(i);
    expect(()=>parseOcrInput({...i,inputFingerprint:"e".repeat(64)},digest)).toThrow("FINGERPRINT_MISMATCH");
    expect(()=>fingerprintOcrInput(i,()=>"bad-hash")).toThrow();
  });
  it("A30: consumer selection compares exact implementation/policy/config versions",()=>{
    const i=fixture(), supported={module:i.module,schemaVersion:i.schemaVersion,implementationVersion:i.implementationVersion,policyVersion:i.policyVersion,resultSchemaVersion:i.resultSchemaVersion,configFingerprint:i.configFingerprint};
    expect(()=>assertOcrCompatibility(i,supported)).not.toThrow();
    for(const input of [{...i,implementationVersion:"ocr/2"},{...i,policyVersion:"evidence/2"},{...i,configFingerprint:"b".repeat(64)}])
      expect(()=>assertOcrCompatibility(input,supported)).toThrow("INCOMPATIBLE_CONSUMER");
  });
  it("A08: completion must match all operation, request and version fields",()=>{
    const i=fixture(), result={...processingIdentity(i),resultKey:"results/ocr-1.json",resultSha256:"b".repeat(64),resultByteSize:200,complete:true};
    expect(()=>assertProcessingResultMatches(i,result,"completion")).not.toThrow();
    for(const field of ["requestId","observationId","operationId","implementationVersion","policyVersion","configFingerprint","inputFingerprint"] as const){
      const value=field.endsWith("Fingerprint")?"e".repeat(64):"other";
      expect(()=>assertProcessingResultMatches(i,{...result,[field]:value},"completion")).toThrow();
    }
    expect(CompletionSchema.safeParse({...result,complete:false}).success).toBe(false);
  });
  it("errors are passive facts; blocked downstream cannot pretend it executed",()=>{
    const i=fixture(), error={schemaVersion:1,requestId:i.requestId,observationId:i.observationId,operationId:i.operationId,
      inputFingerprint:i.inputFingerprint,stage:"ocr",category:"PROCESSING",code:"EXECUTION.OUTCOME_UNKNOWN",executionFact:"unknown",
      evidenceKey:"completions/ocr-1.json",blockedBy:null,automaticRetry:false};
    expect(ReviewSchema.safeParse(error).success).toBe(true);
    expect(ReviewSchema.safeParse({...error,automaticRetry:true}).success).toBe(false);
    expect(ReviewSchema.safeParse({...error,blockedBy:"other"}).success).toBe(false);
    expect(ReviewSchema.safeParse({...error,blockedBy:"other",executionFact:"not_executed"}).success).toBe(true);
    expect(ReviewSchema.safeParse({...error,blockedBy:i.operationId,executionFact:"not_executed"}).success).toBe(false);
  });
  it("requires explicit reuse lineage and matching content/config, never old capture identity",()=>{
    const i=fixture(), target={...i,requestId:"req-2",observationId:"obs-2",operationId:"ocr-2",file:{...i.file,artifactId:"artifact-2",observationId:"obs-2"}};
    const completion={...processingIdentity(i),complete:true,resultKey:"results/ocr-1.json",resultSha256:"e".repeat(64),resultByteSize:20};
    const record={schemaVersion:1,policy:"explicit-file-reuse/1",target,reusedFrom:{input:i,completion}};
    expect(OcrReuseRecordSchema.safeParse(record).success).toBe(true);
    for(const next of [i,{...target,configFingerprint:"d".repeat(64)},{...target,file:{...target.file,sha256:"b".repeat(64)}}])
      expect(OcrReuseRecordSchema.safeParse({...record,target:next}).success).toBe(false);
    expect(OcrReuseRecordSchema.safeParse({...record,reusedFrom:{input:i,completion:{...completion,operationId:"other"}}}).success).toBe(false);
  });
});
