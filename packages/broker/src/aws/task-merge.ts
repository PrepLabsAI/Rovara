// Lane W (contract v0 `tasks.merge`): `POST /v1/dev/tasks/{taskId}/merge`, a person presses Merge on the pull requests their task opened.
//
// Rules:
//   - Every merge rule is the merge core's (`prepareMerge` and `pressMerge`, core/merge/merge.ts): the task's own linked pull requests only, the host re-read for each one, the checks,
//     the proof hold, the required approvals and code owners, the change tier, the merge method and the claim. This module adds NO rule of its own that could let a merge through and
//     never calls a code host itself: it only refuses earlier (sign-in, company, owner, body).
//   - The caller's company comes from membership (resolved by the developer API); a task of another company, a task the caller does not own and a task that does not exist all answer
//     the same "task not found", checked before anything else is read about the task.
//   - DEC 254zzz73: no step-up. A merge needs the signed-in task owner (checked below) and the route table's full-access row; the approvers' proof and the merge core decide the rest.
//   - The deployment wires the merge core for its company's tasks (`TaskMergeWiring`), which needs the core engine's task records on AWS (lane E2). Unwired, the route answers a fixed
//     "not set up" refusal, and nothing is read.
//   - "Merge by itself" (decision 223a) is NOT here: the merge core never merges on its own (owner decision 1), so a per-change opt-in needs the core to grow that first (follow-up).
import { z } from "zod";
import { MERGE_NOT_READY_MESSAGES as M, agentXError, type ApprovalProof } from "@agentx/contracts";
import { prepareMerge, pressMerge, type MergeDependencies, type PreparedMerge } from "../core/merge/merge.js";

export const MERGE_NOT_SET_UP = "merging from Rovara is not set up in this deployment; merge the pull request on the code host";
export const MERGE_BODY = "send a requestId and, if you were shown one, the risk level (low, medium or high)";
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const MergeRequestBodySchema = z.object({ requestId: z.string().uuid(), risk: z.enum(["low", "medium", "high"]).optional() }).strict();

/** What a press carries into the deployment's merge core: who, for which company. */
export interface TaskMergePress {
  companyId: string;
  taskId: string;
  requestId: string;
  presserPersonId: string;
  /** The risk level the person was shown, when the screen showed one: a different level now is "it changed", never merged. */
  risk?: "low" | "medium" | "high" | undefined;
}

/** What the deployment wires for one company: the merge core's dependencies, how a checked press becomes the approver proof, and the task view to answer with. */
export interface TaskMergeWiring {
  merge(companyId: string): MergeDependencies;
  /** The proof the deployment's approvers verify for this press (bound to the prepared request). */
  proofOf(prepared: PreparedMerge, press: TaskMergePress): ApprovalProof;
  view(companyId: string, taskId: string, viewerPersonId: string): Promise<unknown>;
}

const notFound = () => agentXError("TASK_NOT_FOUND", "task not found");

/** The press, through the merge core only. The company and owner checks come first and answer exactly like a missing task. */
export async function pressTaskMerge(wiring: TaskMergeWiring, press: TaskMergePress): Promise<{ task: unknown; merged: true }> {
  const deps = wiring.merge(press.companyId);
  const task = await deps.host.loadTask(press.taskId);
  if (task === undefined || task.orgId !== press.companyId || task.ownerId !== press.presserPersonId) throw notFound();
  const prepared = await prepareMerge(deps, { taskId: press.taskId, requestId: press.requestId, presserPersonId: press.presserPersonId });
  if (press.risk !== undefined && press.risk !== prepared.risk.level) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  await pressMerge(deps, { taskId: press.taskId, requestId: press.requestId, presserPersonId: press.presserPersonId, proof: wiring.proofOf(prepared, press) });
  return { task: await wiring.view(press.companyId, press.taskId, press.presserPersonId), merged: true };
}

/** The route: validated id and body, wiring present, then the press. */
export async function routeTaskMerge(input: {
  wiring: TaskMergeWiring | undefined; companyId: string; taskId: string; personId: string; body: unknown; now: number;
}): Promise<{ task: unknown; merged: true }> {
  if (!TASK_ID.test(input.taskId)) throw notFound();
  if (input.wiring === undefined) throw agentXError("NOT_FOUND", MERGE_NOT_SET_UP);
  const body = MergeRequestBodySchema.safeParse(input.body);
  if (!body.success) throw agentXError("CONFIG_INVALID", MERGE_BODY);
  return pressTaskMerge(input.wiring, { companyId: input.companyId, taskId: input.taskId, requestId: body.data.requestId, presserPersonId: input.personId, ...(body.data.risk === undefined ? {} : { risk: body.data.risk }) });
}
