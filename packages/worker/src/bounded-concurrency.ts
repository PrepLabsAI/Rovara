/**
 * Runs `run(0..count-1)` with at most `limit` in flight and returns the results in index order. After the first failure nothing new starts,
 * `onFailure` is told once (so the caller can stop the others), the runs already in flight are awaited, and that first error is thrown.
 */
export async function runWithConcurrency<T>(count: number, limit: number, run: (index: number) => Promise<T>, onFailure: (error: unknown) => void): Promise<T[]> {
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(limit) || limit < 1) throw new RangeError("concurrency needs a non-negative count and a limit of at least 1");
  const results = new Array<T>(count);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < count) {
      const index = next;
      next += 1;
      try { results[index] = await run(index); }
      catch (error) {
        if (failure === undefined) { failure = { error }; onFailure(error); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, lane));
  if (failure !== undefined) throw failure.error;
  return results;
}
