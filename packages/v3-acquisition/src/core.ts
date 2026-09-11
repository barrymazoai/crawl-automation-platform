import { createHash } from "node:crypto";
import { acquisitionFingerprintMaterial, type FileAcquireInput, type PagePrepareInput } from "@crawl-automation/v3-contracts";
import { AcquisitionError } from "./ports.js";
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function verifyInput(input: FileAcquireInput | PagePrepareInput, configFingerprint: string) {
    if (input.implementationVersion !== "1" || input.policyVersion !== "1" || input.configFingerprint !== configFingerprint)
        throw new AcquisitionError("RUNTIME.INCOMPATIBLE_CONSUMER");
    if (hash(acquisitionFingerprintMaterial(input)) !== input.inputFingerprint)
        throw new AcquisitionError("INPUT.FINGERPRINT_MISMATCH");
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void promise.catch(() => { });
        signal.throwIfAborted();
    }
    let stop: () => void = () => { };
    try {
        return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
                stop = () => reject(signal.reason);
                signal.addEventListener("abort", stop, { once: true });
                if (signal.aborted)
                    stop();
            })]);
    }
    finally {
        signal.removeEventListener("abort", stop);
    }
}
