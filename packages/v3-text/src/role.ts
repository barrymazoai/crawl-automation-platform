import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TextActivityOutcomeSchema } from "@crawl-automation/v3-contracts";
import type { RoleDefinition, WorkerConfig } from "@crawl-automation/v3-worker-runtime";
import { TextModule, type TextDependencies } from "./module.js";
export function createTextRole(options: {
    buildId: string;
    compatibility: string;
    testOnly: boolean;
    prepare(config: Readonly<WorkerConfig>, signal: AbortSignal): Promise<{
        dependencies: TextDependencies;
        dispose(): Promise<void>;
    }>;
}): RoleDefinition {
    return { role: "codex-text", capability: "codex.text", kind: "activity", contractVersion: 1,
        buildId: options.buildId, compatibility: options.compatibility, testOnly: options.testOnly,
        prepare: async (config, signal) => {
            const prepared = await options.prepare(config, signal);
            let module: TextModule;
            try {
                module = new TextModule(prepared.dependencies);
            }
            catch (error) {
                await prepared.dispose();
                throw error;
            }
            return { kind: "activity", dispose: prepared.dispose, activities: { interpretText: async (...args: unknown[]) => {
                        const context = Context.current();
                        if (args.length !== 1 || context.info.attempt !== 1)
                            throw ApplicationFailure.nonRetryable("Text retry denied", "TEXT.RETRY_DENIED");
                        const timer = setInterval(() => context.heartbeat(), 2000);
                        try {
                            return TextActivityOutcomeSchema.parse(await module.run(args[0], context.cancellationSignal));
                        }
                        catch {
                            throw ApplicationFailure.nonRetryable("Text unresolved; inspect private evidence", "TEXT.UNRESOLVED");
                        }
                        finally {
                            clearInterval(timer);
                        }
                    } } };
        } };
}
