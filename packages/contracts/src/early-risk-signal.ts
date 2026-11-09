// The early signal for the task's owner (PR risk "low"), as the task view carries it. Its own small file: the task view's contract (developer-tasks.ts) is in the web app's first JavaScript, and it must
// not pull the whole track record wording (how-we-work-track-record.ts) in with it (tests/contract/web-bundle-budget.test.ts). Browser-safe: nothing here imports a Node module.
import { z } from "zod";

const Count = z.number().int().min(0);
const WindowDays = z.number().int().positive();

/**
 * What the owner of a task reads on the task page when its pull request was published with risk "low": how PRs this project rated low risk went in the last 30 days. Private: the broker sets it only
 * when the viewer is the task's owner, and it is never on the shared card, in a thread or on the pull request. It stays private even above ten samples.
 */
export const EarlyRiskSignalSchema = z.object({
  held: Count,
  notHeld: Count,
  /** The limits the card shows beside a rate, so the early score never reads better than the data. */
  closedUnmerged: Count,
  noOutcome: Count,
  unreviewedMerges: Count,
  windowDays: WindowDays,
  capped: z.boolean(),
  enough: z.boolean(),
});
export type EarlyRiskSignal = z.infer<typeof EarlyRiskSignalSchema>;

/** The score as a view carries it: one this version cannot read is left out, and the rest of the view loads. */
export const EarlyRiskSignalReadSchema = z.unknown().transform((value): EarlyRiskSignal | undefined => { const read = EarlyRiskSignalSchema.safeParse(value); return read.success ? read.data : undefined; });
