// The id of the job a `checkRebuild` queued, for a test that then asks for that job's lease (the lease is asked for by job id and operation id, never for "whatever job the project has").
import type { CheckResult } from "../../packages/broker/src/core/test-env/saved-env.js";

export function queuedJobId(checked: CheckResult): string {
  if (!checked.ok || !checked.queued) throw new Error(`not queued: ${JSON.stringify(checked)}`);
  return checked.job.jobId;
}
