import { z } from "zod";
import { copyBoundedE2EJsonData } from "./e2e-safe-data.js";
import { TestEnvironmentBodySchema } from "./test-environment.js";

/** Part A is deliberately unadvertised. Delivery uses TEST_ENV_PROVE_MEASURE_FEATURE. */
export const SETUP_PROVE_RESULT_PATH = "setup-prove-result" as const;
export const SETUP_PROVE_JOB_MAX_BYTES = 262_144;

// Bound the whole job before the environment parser visits its arrays. A bad input never becomes a partial job.
const boundedJob = z.unknown().transform((value, context) => {
  try {
    return copyBoundedE2EJsonData(value, { maxBytes: SETUP_PROVE_JOB_MAX_BYTES, maxDepth: 16, maxNodes: 16_384 });
  } catch { /* A cyclic or unreadable value is not a job. */ }
  context.addIssue({ code: "custom", message: "invalid setup prove job" });
  return z.NEVER;
});
export const PrepareSetupProveSchema = boundedJob.pipe(z.object({
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  /** Added only at delivery. Never stored with the invocation. */
  leaseToken: z.string().min(16).max(200).optional(),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  environment: TestEnvironmentBodySchema,
  commits: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u), z.string().regex(/^[a-f0-9]{40}$/u))
    .refine(commits => Object.keys(commits).length >= 1 && Object.keys(commits).length <= 16, "one to sixteen repositories"),
}).strict());
export type PrepareSetupProve = z.infer<typeof PrepareSetupProveSchema>;
