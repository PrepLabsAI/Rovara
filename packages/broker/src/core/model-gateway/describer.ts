import { UPKEEP_ORIGIN, isSystemOwnerId, systemOwnerIdOf, ModelRouteSchema, WorkOriginSchema, OperationSchema, SecondReviewerSchema, PAYER_UNRESOLVED, agentXError } from "@agentx/contracts";
import { resolveTaskPayer } from "./cx-a/task-payer.js";
import { upkeepIsOn } from "../upkeep/settings.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskTokenDescriber } from "./token.js";
import { readTaskTokenRecords, type TaskTokenRecords } from "./records.js";

/** Describes only the current core's ordinary task invocations. No request fields or session payer defaults are read. */
export function createTaskTokenDescriber(deps: TaskFlowDeps, reviewers?: Pick<TaskTokenDescriber, "describeReviewer" | "reviewerMinted">): TaskTokenDescriber {
  return {
    ...reviewers,
    async describe(scope, checked) {
      const { operation, workspace, task } = checked ?? await readTaskTokenRecords(deps, scope);
      // Design review slots and multi-model reviewers need their own complete description; never silently grant just one model.
      const second = operation.dispatch?.payload?.["workflowSecondReviewer"];
      if (operation.kind !== "task" || operation.designReview !== undefined || (second !== undefined && (reviewers === undefined || operation.workflowMode !== "REVIEW" || !SecondReviewerSchema.safeParse(second).success))) return undefined;
      const model = ModelRouteSchema.safeParse(operation.modelChoice === undefined ? await deps.modelAccess?.route() : operation.modelChoice.route);
      if (!model.success || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(model.data.alias)) return undefined;
      if (operation.workflowMode !== undefined && !OperationSchema.shape.workflowMode.safeParse(operation.workflowMode).success) return undefined;
      const step = operation.programStepId ?? operation.workflowMode?.toLowerCase() ?? "task";
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(step)) return undefined;
      const resolved = await taskPayerOf(deps, { operation, workspace, task });
      if (resolved === undefined) return undefined;
      const { person, origin, payer, repairDraft } = resolved;
      return { companyId: operation.companyId, project: workspace.projectName, ...(person === undefined ? {} : { person }), payer, taskId: task.taskId, step: repairDraft ? "repair_draft" : step, ...(origin === undefined ? {} : { origin }), models: [model.data.alias], ...(model.data.identity === undefined ? {} : { identity: model.data.identity }) };
    },
  };
}

/** One payer resolution and upkeep gate for main AI and both hosted reviewer kinds. Provider/key selection stays with the gateway. */
export async function taskPayerOf(deps: Pick<TaskFlowDeps, "store" | "companyId" | "systemRuns" | "upkeepRoomCents">, { operation, workspace, task }: TaskTokenRecords) {
  const person = typeof operation.requester?.personId === "string" && /^[a-f0-9]{64}$/u.test(operation.requester.personId) ? operation.requester.personId : undefined;
  const origin = WorkOriginSchema.optional().safeParse(task.origin);
  if (!origin.success || origin.data === "linear") throw agentXError("CALLBACK_FORBIDDEN", PAYER_UNRESOLVED);
  // Lead 4 N1: the origin `nightly` marks nightly UPKEEP AI for the gateway's upkeep cap, so a task that is not a nightly wiki refresh (the model-free nightly test run, any other task somehow marked nightly) gets no model access.
  // L4-SR2: the other upkeep AI is a repair draft: a setup run whose developer is exactly this project's system owner (derived from the company and the project), never a person's setup run marked nightly.
  const repairDraft = origin.data === UPKEEP_ORIGIN && task.purpose === "setup_agent" && isSystemOwnerId(task.developerId) && task.developerId === systemOwnerIdOf(operation.companyId, workspace.projectName);
  if (origin.data === UPKEEP_ORIGIN && task.purpose !== "wiki_build" && !repairDraft) return undefined;
  // L4-SR2 (REVIEW-1 L3): a repair draft's model token is minted only while the company's effective system-runs gate, the project's own upkeep switch AND the upkeep cap's room are all open NOW (read at every mint; an absent gate, a throw or any doubt: no token),
  // so withdrawing consent or switching upkeep off stops new model access at once, not only at the next progress pass.
  if (repairDraft) {
    const open = await (async (): Promise<boolean> => {
      try {
        if (deps.systemRuns === undefined || (await deps.systemRuns.enabled()) !== true || !(await upkeepIsOn({ store: deps.store, companyId: deps.companyId }, workspace.projectName))) return false;
        // L4-SR2b: and the project's upkeep cap has room NOW, as the gateway says (read at every mint). An absent reader, no answer, an invalid one, zero or less: no token (a manual "Fix setup" is another path).
        // "Room above zero" is a stop for an exhausted cap, not a promise of room for the next step: the draft's start needed the whole run's budget, and the gateway holds the real cap on every call.
        const room = deps.upkeepRoomCents === undefined ? undefined : await deps.upkeepRoomCents(workspace.projectName);
        return typeof room === "number" && Number.isSafeInteger(room) && room > 0;
      } catch { return false; }
    })();
    if (!open) return undefined;
  }
  const payer = resolveTaskPayer({ operation, workspace, task }, person, origin.data, repairDraft);
  return { person, origin: origin.data, payer, repairDraft };
}
