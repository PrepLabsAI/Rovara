import { z } from "zod";
// CORE-PARITY: the retired dev paths, with their existing wire schemas, over the core flows.
import {
  DeveloperTaskCloseRequestSchema, WorkflowDecisionRequestSchema, agentXError, type ObjectStorage,
} from "@agentx/contracts";
import { readTaskPlanDocument } from "../aws/task-plan-document.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import type { TaskCaller } from "../core/task-flow/deps.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { loadTaskAsOwner, parseBody } from "../core/task-flow/owner-round.js";
import { loadOwnedTask } from "../core/task-flow/reads.js";
import type { TaskReadDecision } from "../core/task-flow/read-rule.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { CoreDevWiring, DeployedDecisionCaller } from "./dev-routes.js";
import { runParityTaskAction } from "./parity-task-actions.js";

// D-CORE owns the additive preview contract and acceptance fence; the legacy close fields keep their existing validation.
const CloseRequest = DeveloperTaskCloseRequestSchema.extend({ expectedPreviewDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
const PATH = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/(plan|close|workflow\/(?:decision|retry|publish-retry))$/u;
export function parityTaskRoute(path: string, method: string): { taskId: string; action: string } | undefined {
  const match = PATH.exec(path);
  if (match === null || method !== (match[2] === "plan" ? "GET" : "POST")) return undefined;
  return { taskId: match[1]!, action: match[2]! };
}

interface Context {
  flow: TaskFlow;
  blobs: ObjectStorage;
  wiring: CoreDevWiring;
  caller: TaskCaller;
  decisionCaller: DeployedDecisionCaller;
  view(task: TaskRecord): Promise<unknown>;
  /** The one read rule (core/task-flow/read-rule.ts), for the plan body's read: the plan GET never decides who may read itself. */
  decide(read: "plan"): Promise<TaskReadDecision>;
}
const json = (value: unknown): BrokerResponse => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
function bodyOf(request: BrokerRequest): unknown {
  try { return JSON.parse(request.body === undefined || request.body === "" ? "{}" : request.body) as unknown; }
  catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

async function plan(context: Context, record: TaskRecord, request: BrokerRequest): Promise<BrokerResponse> {
  const query = new URL(request.path, "http://core").searchParams;
  const version = query.get("version");
  if (version !== null && (!/^\d{1,3}$/u.test(version) || Number(version) < 1 || Number(version) > 999)) throw agentXError("CONFIG_INVALID", "version must be a whole number from 1 to 999");
  return json({ plan: await readTaskPlanDocument(record, textReaderOf(context.blobs), { document: query.get("document"), ...(version === null ? {} : { version: Number(version) }) }) });
}

/** An unreadable task is refused before its body, query, document or PR can reveal it. */
export async function routeParityTask(context: Context, route: { taskId: string; action: string }, request: BrokerRequest): Promise<BrokerResponse | undefined> {
  const { flow, caller, wiring } = context;
  const { taskId, action } = route;
  // The plan body is a READ: the one read rule decides (its table says owner or co-owner only today). Every other action is an owner move and keeps the owner rule.
  if (action === "plan") return plan(context, (await context.decide("plan")).task, request);
  await loadOwnedTask(flow.deps, caller, taskId);
  if (flow.deps.access.ownerActing === undefined) return undefined;
  await loadTaskAsOwner(flow.deps, caller, taskId);
  const body = bodyOf(request);
  if (action === "close") {
    parseBody(CloseRequest, body);
    // D-CORE supplies the additive input/fence. A function with fewer arguments is assignable here; once integrated the entire body reaches it unchanged.
    const close: (who: TaskCaller, id: string, input?: unknown) => ReturnType<TaskFlow["close"]> = flow.close.bind(flow);
    await close(caller, taskId, body);
  } else if (action === "workflow/decision") {
    if (wiring.workflowDecision === undefined) return undefined;
    await wiring.workflowDecision(context.decisionCaller, taskId, parseBody(WorkflowDecisionRequestSchema, body));
  } else {
    if (wiring.taskActions === undefined) return undefined;
    await runParityTaskAction(flow.deps, { roundCap: wiring.taskActions.roundCap }, caller, taskId, action, body);
  }
  const fresh = await loadOwnedTask(flow.deps, caller, taskId);
  return json({ task: await context.view(fresh), ...closeAnswer(action, fresh) });
}

function closeAnswer(action: string, task: TaskRecord): { closed?: boolean; message?: string } {
  if (action !== "close") return {};
  if (task.closedAt === undefined) return { closed: false, message: "Rovara is closing this task. Read it again in a moment." };
  return { closed: true };
}
