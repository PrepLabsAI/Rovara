import { ROVARA_CODE_AGENT_ID, resolvePayer, agentXError, PAYER_UNRESOLVED, type WorkOrigin } from "@agentx/contracts";
import type { TaskTokenRecords } from "../records.js";

export function resolveTaskPayer({ workspace, task }: TaskTokenRecords, person: string | undefined, origin: WorkOrigin | undefined, repairDraft: boolean) {
  // No project AI setting means projectPays=false. Never infer payer facts from the session.
  let payer;
  try {
    // The task record's purpose decides: wiki builds and repair drafts are paid by the project.
    if (task.purpose === "wiki_build" || repairDraft) {
      payer = { kind: "project" as const, project: workspace.projectName };
    } else if (origin === undefined) {
      // Old records have no origin. The checked starter pays; do not persist a start surface.
      if (person === undefined) throw agentXError("CALLBACK_FORBIDDEN", PAYER_UNRESOLVED);
      payer = { kind: "member" as const, developerId: person };
    } else {
      payer = resolvePayer({ origin, project: workspace.projectName, projectPays: false, agentId: ROVARA_CODE_AGENT_ID, ...(person === undefined ? {} : { startedBy: { developerId: person } }) });
    }
  }
  catch { throw agentXError("CALLBACK_FORBIDDEN", PAYER_UNRESOLVED); }
  return payer;
}
