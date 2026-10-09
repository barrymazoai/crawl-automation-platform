import { CancellationScope } from "@temporalio/workflow";

/** Structured concurrency: cancel siblings on failure, then await their cancellation acknowledgements. */
export async function settleBrandTracks(tracks: (() => Promise<unknown>)[]): Promise<void> {
  const scope = new CancellationScope();
  await scope.run(async () => {
    let firstFailure: { error: unknown } | undefined;
    const tasks = tracks.map((track) =>
      track().catch((error: unknown) => {
        firstFailure ??= { error };
        scope.cancel();
        throw error;
      }),
    );
    await Promise.allSettled(tasks);
    if (firstFailure) {
      throw firstFailure.error;
    }
  });
}
