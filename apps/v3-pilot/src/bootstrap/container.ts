import { asFunction, asValue, createContainer, InjectionMode } from "awilix";
import { LocalEvidence } from "../adapters/local-evidence.js";
import { MockOcr } from "../adapters/mock-ocr.js";
import type { OcrPort, OperationContext } from "../modules/ocr-file.js";
import type { EvidencePort } from "../ports/evidence.js";

interface Dependencies {
  evidence: EvidencePort;
  ocr: OcrPort;
  context: OperationContext;
}
export function createWorkerContainer(
  root: string,
  createOcr: () => OcrPort = () => new MockOcr(),
) {
  const container = createContainer<Dependencies>({
    strict: true,
    injectionMode: InjectionMode.PROXY,
  });
  container.register({
    evidence: asFunction(() => new LocalEvidence(root)).singleton(),
    ocr: asFunction(createOcr)
      .singleton()
      .disposer((ocr) => ocr.close()),
  });
  return container;
}
export type WorkerContainer = ReturnType<typeof createWorkerContainer>;
export async function withOperation<T>(
  container: WorkerContainer,
  context: OperationContext,
  run: (ports: Dependencies) => Promise<T>,
): Promise<T> {
  const scope = container.createScope();
  scope.register({ context: asValue(context) });
  try {
    // The Awilix proxy stays here; the business module receives plain, explicit ports.
    return await run({
      evidence: scope.resolve("evidence"),
      ocr: scope.resolve("ocr"),
      context: scope.resolve("context"),
    });
  } finally {
    await scope.dispose();
  }
}
