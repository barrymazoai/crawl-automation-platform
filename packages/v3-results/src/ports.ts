import type { OcrRegistration } from "@crawl-automation/v3-contracts";
export class ResultError extends Error {
    constructor(readonly code: "RESULT.CONFLICT" | "RESULT.INCOMPLETE" | "RESULT.INTEGRITY" | "RESULT.UNAVAILABLE" | "RESULT.REGISTRATION_UNKNOWN" | "RESULT.NOT_DURABLE") { super(code); this.name = "ResultError"; }
}
export interface CompletionJournal {
    read(operationId: string): Promise<OcrRegistration | null>;
    create(record: OcrRegistration): Promise<void>;
}
export interface ResultRegistry {
    read(operationId: string): Promise<OcrRegistration | null>;
    register(record: OcrRegistration): Promise<void>;
}
export type ResultFacts = {
    computedLocal: boolean;
    artifactDurable: boolean;
    resultRegistered: boolean;
    record: OcrRegistration | null;
};
