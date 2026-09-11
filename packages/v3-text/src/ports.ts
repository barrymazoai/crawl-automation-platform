import type { TextCompatibility, TextInput, TextRecord } from "@crawl-automation/v3-contracts";
export { CodexError as TextError } from "@crawl-automation/v3-codex";
export interface TextProvider {
    readonly provider: string;
    readonly supported: TextCompatibility;
    // Business execution boundary. Internal Codex model requests are not business retries.
    readonly policy: {
        executionRetries: 0;
        internalModelRequests: "codex-managed";
        toolAccess: "runtime-profile";
        modelFallback: false;
        networkSwitching: false;
    };
    interpret(request: {
        operationId: string;
        prompt: string;
        outputSchema: object;
    }, signal: AbortSignal): Promise<string>;
    close(): Promise<void>;
}
export interface TextRegistry {
    read(id: string): Promise<TextRecord | null>;
    register(record: TextRecord): Promise<void>;
}
export interface QueryPort {
    query(sql: string, params?: unknown[]): Promise<{
        rows: Record<string, unknown>[];
    }>;
}
export type TextFacts = {
    computedLocal: boolean;
    artifactDurable: boolean;
    resultRegistered: boolean;
    record: TextRecord | null;
};
export type TextRequest = TextInput;
