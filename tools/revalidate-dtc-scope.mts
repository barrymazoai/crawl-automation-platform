/** Mini-only CRAWLV3-181 revalidation of already-finished answers; no model/client/browser creation. */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkerConfigSchema } from "../apps/worker/src/config.js";
import { createR2Objects, sha256 } from "../packages/platform/src/index.js";
import { captureFile, captureOutputFiles, CaptureFileSchema } from "../packages/channels/dtc/src/agent/archive.js";
import { readCapturedProduct } from "../packages/channels/dtc/src/agent/product-record.js";
import { productScopeFields, validateProductScope } from "../packages/channels/dtc/src/agent/product-scope.js";
import { ProductPipelineInputSchema } from "../packages/workflows/src/pipeline-model.js";
import { connectTemporal } from "../packages/platform/src/index.js";
import { verifyRetainedScopeBoundary } from "./verify-dtc-scope-boundary.mjs";

const [configPath, previous, output] = process.argv.slice(2);
if (!configPath || !previous || !output) throw new Error("Usage: <worker-config> <previous-acceptance-dir> <new-output-dir>");
await mkdir(output, { mode: 0o700 });
const config = WorkerConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const r2 = createR2Objects(config.storage.r2, config.storage.r2Credentials);
const temporal = await connectTemporal(config.temporal);
const signal = AbortSignal.timeout(300_000);
async function exactRemote(key: string, local: Uint8Array) {
  const bytes = await r2.store.read(key, local.byteLength, signal);
  if (!bytes || bytes.byteLength !== local.byteLength || sha256(bytes) !== sha256(local)) throw new Error(`R2 mismatch: ${key}`);
  return bytes;
}
try {
  for (let index = 0; index < 3; index++) {
    const intent = JSON.parse(await readFile(join(previous, `case-${index}-intent.json`), "utf8"));
    const archive = await r2.store.read(intent.archiveKey, 1_000_000, signal);
    if (!archive || sha256(archive) !== intent.archiveSha256) throw new Error("Original manifest mismatch");
    const files = CaptureFileSchema.array().parse(JSON.parse(Buffer.from(archive).toString()).files);
    for (let offset = 0; offset < files.length; offset += 4) {
      await Promise.all(files.slice(offset, offset + 4).map(async file => {
        const local = await captureFile(intent.sample.workspace, file.path);
        if (local.byteLength !== file.byteSize || sha256(local) !== file.sha256) throw new Error("Local original mismatch");
        await exactRemote(file.objectKey, local);
      }));
    }
    const root = join(intent.sample.workspace, "capture");
    const captured = captureOutputFiles(files);
    const retained = await readCapturedProduct({ root, ...captured, url: intent.evidence.url, requireObservedMethod: true });
    const history = await temporal.client.workflow.getHandle(`product-run-${intent.sample.runId}`).fetchHistory();
    const payload = history.events?.find(e => e.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    if (!payload) throw new Error("Original history input missing");
    const original = ProductPipelineInputSchema.parse(JSON.parse(Buffer.from(payload).toString()));
    const scopeRoot = join(previous, "publications/v3/dtc-product-scope");
    let matching: { key: string; answer: Buffer } | undefined;
    for (const digest of await readdir(scopeRoot)) {
      const inputPath = join(scopeRoot, digest, "input.json");
      const inputBytes = await readFile(inputPath);
      const input = JSON.parse(inputBytes.toString());
      if (input.operationId !== intent.workflowId) continue;
      await exactRemote(`v3/dtc-product-scope/${digest}/input.json`, inputBytes);
      const fields = productScopeFields(retained.record);
      const { variants: _inventory, ...websiteFields } = fields;
      if (input.url !== original.url || JSON.stringify(input.fields) !== JSON.stringify(websiteFields) ||
          JSON.stringify(input.variants) !== JSON.stringify(retained.record.variants)) throw new Error("Answer source mismatch");
      const answer = await readFile(join(scopeRoot, digest, "answer.json"));
      const key = `v3/dtc-product-scope/${digest}/answer.json`;
      await exactRemote(key, answer);
      matching = { key, answer };
    }
    if (!matching) throw new Error("Retained answer missing");
    const decision = validateProductScope(JSON.parse(JSON.parse(matching.answer.toString()).answer), productScopeFields(retained.record));
    if (decision.kind !== intent.sample.expected) throw new Error("Unexpected decision");
    const result = { decision, evidence: { objectKey: matching.key, sha256: sha256(matching.answer), byteSize: matching.answer.length } };
    const boundary = await verifyRetainedScopeBoundary({ config, original, root, captured, result });
    const proof = { sourceWorkflowId: intent.workflowId, sourceRunId: intent.sample.runId, files: files.length, modelCalls: 0, originalAnswer: result.evidence, decision, boundary };
    await writeFile(join(output, `case-${index}.json`), JSON.stringify(proof, null, 2), { flag: "wx" });
    console.log(JSON.stringify(proof));
  }
} finally {
  r2.close();
  await temporal.close();
}
