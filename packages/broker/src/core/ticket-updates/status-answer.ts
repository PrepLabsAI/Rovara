// What a tracker's answer to "move this ticket to the status named" means for the project's own words (R1 + L1 6.2). The three answers that are not a move are told apart and none is silent:
//   - `no_such_status`: the tracker's team has no status with that name ("In Review"). Noted per project and moment (`noteStatusMissing`) for the project's ticket-updates card, and logged; the comment still goes;
//   - `not_forward`: the ticket is already further along (or finished), so it was left as it is. Logged only;
//   - `moved`: whatever was noted as missing for this project and moment is cleared.
// Best effort in every branch: a ticket update never fails the task, and a failure to note is not an error of the update.
import type { OrgId } from "@agentx/contracts";
import { clearStatusMissing, noteStatusMissing, type StatusNoteTable } from "./settings.js";

export async function noteStatusAnswer(
  deps: StatusNoteTable & { log?: ((event: string, fields: Record<string, unknown>) => void) | undefined },
  input: { orgId: OrgId; tracker: string; project: string; moment: string; name: string; answer: string },
): Promise<void> {
  const { orgId, tracker, project, moment, name, answer } = input;
  try {
    if (answer === "no_such_status") {
      deps.log?.("ticket_update.status_missing", { orgId, tracker, project, moment });
      await noteStatusMissing(deps, orgId, tracker, project, moment, name);
    } else if (answer === "not_forward") {
      deps.log?.("ticket_update.status_not_forward", { orgId, tracker, project, moment });
    } else if (answer === "moved") {
      await clearStatusMissing(deps, orgId, tracker, project, moment);
    }
  } catch {
    deps.log?.("ticket_update.status_note_failed", { orgId, tracker, project, moment });
  }
}
