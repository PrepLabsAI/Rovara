/** SSM GetParameters accepts at most this many names per call; a larger request fails whole with a ValidationException. */
export const SSM_GET_PARAMETERS_MAX_NAMES = 10;

/** What one GetParameters call answers, as far as callers read it (a structural subset of the SDK's output). */
export interface SsmGetParametersAnswer {
  Parameters?: ReadonlyArray<{ Name?: string | undefined; Value?: string | undefined }> | undefined;
  InvalidParameters?: readonly string[] | undefined;
}

/**
 * Reads parameters by name in calls of at most 10 names (the API limit) and merges the answers. Every GetParameters call in the
 * codebase goes through this, so a settings list can grow past 10 without a launch failing. A name SSM does not find comes back
 * in `InvalidParameters` of its own batch and is kept in the merged answer, so a missing parameter fails callers exactly as it
 * did in a single call (they find no value for it). A batch that fails (access denied, throttling) fails the whole read.
 */
export async function getParametersInBatches<Answer extends SsmGetParametersAnswer>(
  names: readonly string[],
  read: (batch: string[]) => Promise<Answer>,
): Promise<{ Parameters: Array<{ Name?: string | undefined; Value?: string | undefined }>; InvalidParameters: string[] }> {
  const unique = [...new Set(names)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += SSM_GET_PARAMETERS_MAX_NAMES) batches.push(unique.slice(start, start + SSM_GET_PARAMETERS_MAX_NAMES));
  const answers = await Promise.all(batches.map((batch) => read(batch)));
  return {
    Parameters: answers.flatMap((answer) => [...(answer.Parameters ?? [])]),
    InvalidParameters: answers.flatMap((answer) => [...(answer.InvalidParameters ?? [])]),
  };
}
