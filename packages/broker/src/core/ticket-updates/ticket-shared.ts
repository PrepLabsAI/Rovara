// Whether a task counts as SHARED for the ticket thread because it was started from a ticket (owner decision 254zzq). The ticket is itself a shared place: everyone who can see it sees what Rovara writes there, and
// the project chose how much may be written (its level). So a task that intake started FROM A TICKET is shared with its project for the thread's purposes once the project's level is above `status_only`, although it has no
// share row and no People entry (it is its starter's task alone in every other record). Without this, a ticket-started task stays at `status_only` on a tracker that cannot make an internal comment, whatever the level.
//
// The rule is narrow and fails closed. A task counts only when ALL of these hold; every other answer is `false` (the caller then asks the records, `taskSharedOf`, as before):
//   - the handler's scope covers this company, and the task's own record names this company (a task id is not company-scoped);
//   - the project's level is above `status_only`, read from this company's own settings (a missing, unreadable or old settings item reads as `status_only`);
//   - the ticket is the one intake started THIS task from, by the strict rule the thread itself uses (`originTicketOf` with `strict`: the intake item is `started` and NAMES this task). A ticket someone linked by hand, a
//     duplicate or raced start, a task started from Slack, the web or an AI tool, and a task with no session or no project never count.
// What it does not change: a task only its owner can see that did not start from a ticket (every such task is as before: not shared); a laptop (no `taskShared` is given there, so a laptop's tasks are still the owner's alone);
// the level, the claim, the limits, the words and what may leave (`effectiveLevel`, `thread-render.ts`), and the one-shot comments at `status_only`.
import { ticketUpdateLevelOf, type OrgId } from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import { scopeCoversCompany } from "./claims.js";
import { originTicketOf, type TicketUpdatesDependencies } from "./handler.js";
import { readTicketUpdates } from "./settings.js";

/**
 * The `taskShared` answer for the ticket updates: true for a task started from a ticket above `status_only` (see the file's words), otherwise what `base` says (the records: a session share, a People entry, a takeover).
 * `base` is asked only when the ticket rule did not already say yes; a failure of `base` is the caller's (`effectiveLevel` takes it as "not shared").
 */
export function ticketStartedShared(
  deps: Pick<TicketUpdatesDependencies, "store" | "now" | "scope">, base?: (orgId: OrgId, taskId: string) => Promise<boolean>,
): (orgId: OrgId, taskId: string) => Promise<boolean> {
  return async (orgId, taskId) => {
    if (await startedFromTicket(deps, orgId, taskId)) return true;
    return base === undefined ? false : base(orgId, taskId);
  };
}

async function startedFromTicket(deps: Pick<TicketUpdatesDependencies, "store" | "now" | "scope">, orgId: OrgId, taskId: string): Promise<boolean> {
  if (!scopeCoversCompany(deps.scope, orgId)) return false;
  const task = await deps.store.get(taskKey(taskId));
  if (task === undefined || (task["orgId"] ?? task["companyId"]) !== orgId) return false;
  const project = task["project"];
  const sessionId = task["sessionId"];
  if (typeof project !== "string" || typeof sessionId !== "string") return false;
  // The project's own level, from this company's own settings: at `status_only` the ticket gets fixed words only, so no share is in question.
  if (ticketUpdateLevelOf((await readTicketUpdates(deps, orgId, project)).settings) === "status_only") return false;
  return (await originTicketOf(deps, { orgId, project, taskId, sessionId }, { strict: true })) !== undefined;
}
