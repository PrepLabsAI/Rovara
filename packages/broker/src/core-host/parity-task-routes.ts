import { z } from "zod";
// CORE-PARITY: the retired dev paths, with their existing wire schemas, over the core flows.
import {
  DeveloperTaskCloseRequestSchema, TaskCloseActionSchema, WorkflowDecisionRequestSchema, agentXError, type ObjectStorage,
} from "@agentx/contracts";
import { readTaskPlanDocument } from "../aws/task-plan-document.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import type { TaskCaller, TaskFlowDeps } from "../core/task-flow/deps.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { loadTaskAsOwner, parseBody } from "../core/task-flow/owner-round.js";
import { loadOwnedTask } from "../core/task-flow/reads.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { CoreDevWiring, DeployedDecisionCaller } from "./dev-routes.js";
import { runParityTaskAction } from "./parity-task-actions.js";

// D-CORE owns the additive preview contract and acceptance fence; the legacy close fields keep their existing validation.
const CloseRequest = DeveloperTaskCloseRequestSchema.extend({ expectedPreviewDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
const PATH = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/(plan|close|workflow\/(?:decision|retry|publish-retry))$/u;
/** The methods each action answers: the plan is read, the close is read (its preview) and written, the rest are written. */
const METHODS: Readonly<Record<string, readonly string[]>> = { plan: ["GET"], close: ["GET", "POST"] };
export function parityTaskRoute(path: string, method: string): { taskId: string; action: string } | undefined {
  const match = PATH.exec(path);
  if (match === null || !(METHODS[match[2]!] ?? ["POST"]).includes(method)) return undefined;
  return { taskId: match[1]!, action: match[2]! };
}

const GUARDED_CLOSE_FIELDS = ["expectedPreviewDigest", "discard_unpublished", "discardUnpublished"] as const;
/**
 * A close bound to a preview, or one that discards, needs the retained-inspection provider this install may not have yet. It is refused BEFORE any read with the words the session route uses, so a missing
 * provider never reads as a stale preview. Anything that is not a JSON object is left to the close's own validation.
 */
export function requireGuardedCloseReady(deps: Pick<TaskFlowDeps, "closeInspection">, body: unknown): void {
  if (deps.closeInspection !== undefined || typeof body !== "object" || body === null || Array.isArray(body)) return;
  if (GUARDED_CLOSE_FIELDS.some((field) => Object.hasOwn(body, field))) throw agentXError("RUNTIME_UNAVAILABLE", "Guarded close and discarding unpublished work are not available yet.");
}

function lenientBody(request: BrokerRequest): unknown {
  try { return JSON.parse(request.body === undefined || request.body === "" ? "{}" : request.body) as unknown; } catch { return undefined; }
}

/** `GET .../close?action=close|discard`: exactly one query key. The answer is the flow's, unchanged: `{preview}` or `{preview: null, unavailable}`. It reads and writes nothing else. */
async function closePreview(context: Context, taskId: string, request: BrokerRequest): Promise<BrokerResponse> {
  const query = new URL(request.path, "http://core").searchParams;
  const keys = [...query.keys()];
  const action = keys.length === 1 && keys[0] === "action" ? TaskCloseActionSchema.safeParse(query.get("action")) : undefined;
  if (action?.success !== true) throw agentXError("CONFIG_INVALID", "the close preview takes only ?action=close or ?action=discard");
  return json(await context.flow.previewClose(context.caller, taskId, action.data));
}

interface Context {
  flow: TaskFlow;
  blobs: ObjectStorage;
  wiring: CoreDevWiring;
  caller: TaskCaller;
  decisionCaller: DeployedDecisionCaller;
  view(task: TaskRecord): Promise<unknown>;
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
  if (action === "close" && request.method === "POST") requireGuardedCloseReady(flow.deps, lenientBody(request));
  const record = await loadOwnedTask(flow.deps, caller, taskId);
  if (action === "plan") return plan(context, record, request);
  if (flow.deps.access.ownerActing === undefined) return undefined;
  // The preview names repositories, so it is the owner's like the close it belongs to (a reader the task was shared with gets the missing-task answer above, never the facts).
  await loadTaskAsOwner(flow.deps, caller, taskId);
  if (action === "close" && request.method === "GET") return closePreview(context, taskId, request);
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
