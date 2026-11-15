import { ModelRouteSchema, WorkOriginSchema, OperationSchema, PAYER_UNRESOLVED, resolvePayer, agentXError } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskTokenDescriber } from "./token.js";
import { readTaskTokenRecords } from "./records.js";

/** Describes only the current core's ordinary task invocations. No request fields or session payer defaults are read. */
export function createTaskTokenDescriber(deps: TaskFlowDeps): TaskTokenDescriber {
  return {
    async describe(scope, checked) {
      const { operation, workspace, task } = checked ?? await readTaskTokenRecords(deps, scope);
      // Design review slots and multi-model reviewers need their own complete description; never silently grant just one model.
      if (operation.kind !== "task" || operation.designReview !== undefined || operation.dispatch?.payload?.["workflowSecondReviewer"] !== undefined) return undefined;
      const model = ModelRouteSchema.safeParse(operation.modelChoice === undefined ? await deps.modelAccess?.route() : operation.modelChoice.route);
      if (!model.success || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(model.data.alias)) return undefined;
      if (operation.workflowMode !== undefined && !OperationSchema.shape.workflowMode.safeParse(operation.workflowMode).success) return undefined;
      const step = operation.programStepId ?? operation.workflowMode?.toLowerCase() ?? "task";
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(step)) return undefined;
      const person = typeof operation.requester?.personId === "string" && /^[a-f0-9]{64}$/u.test(operation.requester.personId) ? operation.requester.personId : undefined;
      const origin = WorkOriginSchema.safeParse(task.origin);
      if (!origin.success) throw agentXError("CALLBACK_FORBIDDEN", PAYER_UNRESOLVED);
      // This base has no project AI payer setting, chain payer or assigner facts. Missing
      // is unavailable, never projectPays=false or a session's assumed member payer.
      let payer;
      try { payer = resolvePayer({ origin: origin.data, project: workspace.projectName, ...(person === undefined ? {} : { startedBy: { developerId: person } }) }); }
      catch { throw agentXError("CALLBACK_FORBIDDEN", PAYER_UNRESOLVED); }
      return { companyId: operation.companyId, project: workspace.projectName, ...(person === undefined ? {} : { person }), payer, taskId: task.taskId, step, origin: origin.data, models: [model.data.alias] };
    },
  };
}
