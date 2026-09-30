import { acquisitionFingerprintMaterial, type FileAcquireInput, type PagePrepareInput } from "@crawl-automation/v3-contracts";
import { FILE_CONFIG_FINGERPRINT } from "./file.js";
import { PAGE_CONFIG_FINGERPRINT } from "./page.js";
import { hash } from "./core.js";
import type { SourceLease, Response } from "./ports.js";
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=", "base64");
export function sign<T extends FileAcquireInput | PagePrepareInput>(input: T): T { return { ...input, inputFingerprint: hash(acquisitionFingerprintMaterial(input)) }; }
export function fileInput(): FileAcquireInput {
    return sign({ schemaVersion: 1, requestId: "req-1", observationId: "obs-1", operationId: "file-op-1", brandId: "brand-1", sourceId: "source-1", listingId: "listing-1", variantId: null,
        module: "file.acquire", implementationVersion: "1", policyVersion: "1", configFingerprint: FILE_CONFIG_FINGERPRINT, inputFingerprint: "0".repeat(64), resourceId: "image-1",
        binding: { sessionId: "session-1", egressId: "direct/1" }, expectedSha256: null });
}
export function response(bytes = png, headers: Response["headers"] = { "content-type": "image/png" }, status = 200): Response {
    return { status, headers, body: (async function* () { yield bytes; })(), close: () => { } };
}
export function lease(get: SourceLease["transport"]["get"] = async () => response()): SourceLease {
    return { owner: { schemaVersion: 1, requestId: "req-1", observationId: "obs-1", brandId: "brand-1", sourceId: "source-1", listingId: "listing-1", variantId: null },
        sourceId: "source-1", binding: { sessionId: "session-1", egressId: "direct/1" }, resourceId: "image-1", url: "https://files.example/image?signature=private-canary",
        allowedOrigins: ["https://files.example", "https://cdn.example"], transport: { egressId: "direct/1", get }, assertActive: () => { }, headersFor: () => ({ cookie: "private-cookie-canary" }), release: async () => { } };
}
export function pageInput(html: string) {
    const bytes = Buffer.from(html), base = fileInput();
    const input: PagePrepareInput = sign({ schemaVersion: 1, requestId: base.requestId, observationId: base.observationId, operationId: "page-op-1", brandId: base.brandId, sourceId: base.sourceId, listingId: base.listingId, variantId: null,
        module: "page.prepare", implementationVersion: "1", policyVersion: "1", configFingerprint: PAGE_CONFIG_FINGERPRINT, inputFingerprint: "0".repeat(64),
        page: { schemaVersion: 1, artifactId: "html-1", observationId: base.observationId, sourceId: base.sourceId, listingId: base.listingId, variantId: null,
            kind: "source-html", mediaType: "text/html", sha256: hash(bytes), byteSize: bytes.length, objectKey: "capture/page.html", producer: { operationId: "capture-1", module: "capture", implementationVersion: "1" } } });
    return { input, bytes };
}
