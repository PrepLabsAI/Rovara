// L4-EVH (DEC 254zzz20 D5): the model access of the opt-in eval HEALTH RUN's own preparation. A health run has no task: it is a read-only, pinned preparation the broker made for one claimed request (`evalHealth` in its stored
// dispatch). Its worker asks for a task token the same way a CHECKS run does, and gets one only while ALL of these hold, read from the broker's own records (nothing from the request but the capability):
//   - the operation is this company's live prepare operation, in the workspace the capability names, at its fence, and its stored dispatch carries `evalHealth`;
//   - the request row of that workspace's project is `running` under exactly that request and claim, inside its window.
// The token names the company, the project (the workspace's), the project as the payer (never a person's own spend), the run's own id as the work and the install's one model route, and nothing else. A run whose claim
// ended, expired or moved on reads "no model access", like any other operation without one.
import { ModelRouteSchema, OperationStatusSchema, PrepareEvalHealthSchema, WorkspaceStatusSchema, agentXError } from "@agentx/contracts";
import { evalHealthRunExpired, readEvalHealthRow } from "../setup-agent/eval-health-request.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "../task-flow/records.js";
import { isTerminalStatus } from "../task-flow/results.js";
import { locateWorkspace } from "../task-flow/workspace-location.js";
import type { TaskTokenDeadline } from "./deadline.js";
import type { TaskTokenDescriber, TaskTokenOperation } from "./token.js";

const refused = () => agentXError("CALLBACK_FORBIDDEN", "this operation has no model access");

/** The describer of a health run's token, or undefined when this operation is not a health run's preparation (the caller then takes the task path). Throws the fixed refusal for a health run that may not have access. */
export async function evalHealthTokenDescriber(deps: Pick<TaskFlowDeps, "store" | "companyId" | "now" | "modelAccess">, scope: TaskTokenOperation, deadline?: TaskTokenDeadline): Promise<TaskTokenDescriber | undefined> {
  deadline?.check();
  const location = await locateWorkspace({ companyId: deps.companyId, store: { get: async (key) => { deadline?.check(); return deps.store.get(key); } } }, scope.workspaceId);
  if (location === undefined) return undefined;
  const operation = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(scope.operationId)));
  // Anything that is not a prepare operation is a task's (or another's): not this path, and nothing about it is learned here.
  if (operation === undefined || operation.kind !== "prepare") return undefined;
  const job = PrepareEvalHealthSchema.safeParse((operation.dispatch?.payload as Record<string, unknown> | undefined)?.["evalHealth"]);
  if (!job.success) return undefined;
  const workspace = fromDocument<WorkspaceRecord>(location.workspace);
  if (operation.companyId !== deps.companyId || operation.id !== scope.operationId || operation.workspaceId !== scope.workspaceId || workspace === undefined || workspace.companyId !== deps.companyId || workspace.id !== scope.workspaceId) throw refused();
  if (operation.fence !== scope.fence || workspace.fence !== scope.fence || workspace.activeOperationId !== scope.operationId) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
  if (!OperationStatusSchema.safeParse(operation.status).success || isTerminalStatus(operation.status) || operation.status === "CANCEL_REQUESTED") throw refused();
  if (!WorkspaceStatusSchema.safeParse(workspace.status).success || workspace.closedAt !== undefined || ["CLOSING", "CLOSED", "STOPPED"].includes(workspace.status)) throw refused();
  const project = workspace.projectName;
  if (typeof project !== "string" || project === "") throw refused();
  deadline?.check();
  // The claim must be the live one: this request, this claim, still running, inside its window.
  const row = await readEvalHealthRow({ store: deps.store, companyId: deps.companyId }, project);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  if (row === undefined || row.state !== "running" || row.requestId !== job.data.requestId || row.claim?.claimId !== job.data.claimId || evalHealthRunExpired(row, nowMs)) throw refused();
  const route = ModelRouteSchema.safeParse(await deps.modelAccess?.route());
  if (!route.success || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(route.data.alias)) throw refused();
  const taskId = `eval-health-${job.data.requestId}`;
  return { async describe() { return { companyId: deps.companyId, project, payer: { kind: "project" as const, project }, taskId, step: "eval-health", models: [route.data.alias] }; } };
}
