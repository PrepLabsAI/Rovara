// Lane L4-C B5 (design pr-redesign.md 2.6): the comments Rovara writes on a pull request for the CI fix loop. The description is the state, the Check is the gate, and a comment is an event that needs a person (it sends a
// notification), so there are only two, and never one for good news:
//   - Rovara pushes a fix for failing CI after the pull request is already out of draft: a reviewer's earlier read of the code may now be stale, so trust changed. One line per round.
//   - Rovara is stuck (it asked or stopped, and needs a person). One line, once per stop.
// The words are fixed except the failing checks' names, which a repository wrote: made inert (no mention, link, image or issue key), one line, cut. At most once for each event: the event is a committed workflow change
// (a round counted, a task stopped), and the comment is posted only after that commit, so a pass that lost its race or ran twice never posts it twice. A failure to post is not retried.
import { CI_FIX_ROUNDS_MAX, type CodeHost, type HostScope, type ReadBudget } from "@agentx/contracts";
import { inertLine } from "../proof/inert-text.js";
import { breakLinearKeys, neutralizeLinearWords } from "../proof/linear-close.js";
import type { MergeActionRequest } from "../branch-sync/merge-action.js";

/** The longest comment (characters); the code host refuses more, and a notification is a short thing. */
export const CI_FIX_COMMENT_MAX = 300;

const failingNames = (failing: readonly string[]): string => {
  const shown = failing.slice(0, 3).map((name) => breakLinearKeys(neutralizeLinearWords(inertLine(name, 60)))).filter((name) => name !== "");
  const more = failing.length - shown.length;
  return shown.length === 0 ? "a check" : `${shown.join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`;
};
const cut = (text: string): string => (Array.from(text).length <= CI_FIX_COMMENT_MAX ? text : `${Array.from(text).slice(0, CI_FIX_COMMENT_MAX - 1).join("")}…`);

/** The comment for a fix round: "Rovara is fixing failing CI (round 2 of 3): <what failed>. The description is updated when the fix is pushed." */
export const fixRoundComment = (input: { round: number; failing: readonly string[] }): string =>
  cut(`Rovara is fixing failing CI (round ${String(Math.max(1, Math.trunc(input.round)))} of ${String(CI_FIX_ROUNDS_MAX)}): ${failingNames(input.failing)}. The description is updated when the fix is pushed.`);

/** The comment for a stop: Rovara could not go on and a person has to. */
export const stuckComment = (input: { failing: readonly string[] }): string =>
  cut(`Rovara could not fix ${failingNames(input.failing)} and has stopped. It needs a person: open this task in Rovara to see why and to let it go on.`);

/**
 * The comment this tracking decision is due, if any. Only a CI-fix decision makes one: a counted round ("fixing") when the pull request is already out of draft, and a stop ("stuck") whatever the draft state. Anything else,
 * and a draft's own fix rounds (nobody has looked at it yet), is silent. `rounds` is the CI fix rounds counted by the decided workflow.
 */
export function ciFixComment(action: Pick<MergeActionRequest, "slot" | "milestones"> | undefined, input: { draft: boolean; rounds: number; failing: readonly string[] }): string | undefined {
  if (action === undefined || action.slot !== "ci_fix") return undefined;
  const kinds = new Set(action.milestones.map((entry) => entry.milestone.kind));
  if (kinds.has("stuck")) return stuckComment({ failing: input.failing });
  if (kinds.has("fixing") && !input.draft) return fixRoundComment({ round: input.rounds, failing: input.failing });
  return undefined;
}

/** Posts it, best effort and once: a host that cannot, or any failure, is logged by error name and not retried. */
export async function postCiFixComment(host: Pick<CodeHost, "postComment">, ref: Parameters<NonNullable<CodeHost["postComment"]>>[0], text: string | undefined, scope: HostScope, budget: ReadBudget | undefined, log?: (event: string, fields: Record<string, unknown>) => void): Promise<boolean> {
  if (text === undefined || host.postComment === undefined) return false;
  try {
    await host.postComment(ref, text, scope, budget);
    return true;
  } catch (error) {
    log?.("merge_tracking.ci_fix_comment_not_posted", { error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
