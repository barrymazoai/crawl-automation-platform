import { ApplicationFailure } from "@temporalio/common";
import type { z } from "zod";

// A transport wrapper only. Provider calls, result recovery and operation-scoped DI belong to the module factory.
export function checkedActivity<I, O>(input: z.ZodType<I>, output: z.ZodType<O>, run: (input: I) => Promise<O>) {
  return async (...args: unknown[]): Promise<unknown> => {
    const parsed = input.safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) throw ApplicationFailure.nonRetryable("Invalid module input", "CONTRACT.INPUT_INVALID");
    const result = await run(parsed.data);
    const checked = output.safeParse(result);
    if (!checked.success) throw ApplicationFailure.nonRetryable("Invalid module output; preserve evidence before review", "CONTRACT.OUTPUT_INVALID");
    return checked.data;
  };
}
