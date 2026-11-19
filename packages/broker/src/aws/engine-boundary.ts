import { logWorkspacePointerIntegrity } from "../core/task-flow/workspace-pointer.js";
// Engine boundary (migration plan v3.2 lane E2, step 6 part): every AWS entry point that reads or acts on an EXISTING task goes by the task's stored engine (its stamp,
// core-host/engine-stamp.ts), never by the switch.
//
//   - A task with no stamp (every task that exists today, and every task started while the switch is off) is a spec 056 workflow task: today's AWS readers answer it, unchanged.
//   - A task stamped `core` is the core's. The developer task routes hand it to the core's own handlers (`CoreTaskEntry`, the core host's dev routes: company-aware, they check the
//     caller's company on every read). Nothing on the AWS side reads its record, its workspace or its operations. Without a core entry on this install, or for an operation the core
//     does not serve yet, the answer is a fixed refusal that never says more than a missing task would to someone who may not see it.
//
// One owner per operation, for every stamp, including the mixed ones a later lane may write (flow = core with build or merge narrowed to the workflow):
//   the entry point that reads or acts on a task's rows belongs to the engine that runs its FLOW. Only that engine's start wrote the task's record, workspace, pointer and operations,
//   so only it may read them. A narrowed area names where that area's steps run inside the flow's engine; it never hands the task's rows to the other engine's readers. A stamp
//   whose flow is the workflow keeps the whole task on the workflow (the core never reads a task its start did not write), whatever its other areas say.
//
// A stamp is written once, with the core task, in the start's own transaction, and never changes; a task without one never gets one. So a verdict about a task that EXISTS is fixed for
// good and is kept (bounded) per state table client. A verdict about an id with no task behind it is never kept, except `core` (a stamp, once there, stays).
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXErrorCodeSchema, OrgIdSchema, agentXError, type ActorRef, type ConversationRef, type DeveloperSignInMethod } from "@agentx/contracts";
import { workspaceKey, taskPointerKey as scopedTaskPointerKey } from "../core/task-flow/keys.js";
import { engineStampKey, stampOf, type Engine, type EngineStamp } from "../core-host/engine-stamp.js";
import type { CoreArea } from "../core-host/flags.js";
import { NOT_ON_THE_CORE_YET, type DeployedCaller } from "../core-host/dev-routes.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { taskPointerKey } from "../developer/task-records.js";
import type { ChatThreadInput, ChatThreadInputResult } from "../core-host/chat-thread-input.js";
import type { ChatDecisionPress, ChatDecisionResult } from "../core-host/chat-decision.js";

/** The state table, as every AWS reader holds it. */
export interface EngineStateTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** The developer task routes, each with the area of the work it touches. The owner is decided by `entryOwner`, not by this area (see the header). */
export const TASK_ENTRY_AREAS = {
  read: "flow", events: "flow", plan: "flow", messages: "flow", comments: "flow", people: "flow", "people/role": "flow", "people/take-ownership": "flow", "people/requests": "flow", "people/candidates": "flow", "people/add": "flow",
  readers: "flow", share: "flow", cancel: "flow", close: "flow", "workflow/decision": "flow", "canvas-closeout/retry": "flow", answers: "flow", evidence: "flow",
  continue: "build", "workflow/retry": "build", "workflow/review": "build", "workflow/send-back": "build", "workflow/review-findings": "build",
  diff: "merge", "pull-requests": "merge", "workflow/publish-retry": "merge", "workflow/keep-pull-requests": "merge", "workflow/feedback": "merge", "workflow/feedback-decision": "merge",
  "workflow/feedback-retry": "merge", "e2e-publication-context": "merge",
} as const satisfies Record<string, CoreArea>;
export type TaskEntryOperation = keyof typeof TASK_ENTRY_AREAS;

/** The one owner of an operation of an existing task. No stamp, or one that cannot be read: the workflow. Otherwise the engine that runs the task's flow, whatever the operation's area. */
export function entryOwner(stamp: EngineStamp | undefined, area: CoreArea): Engine {
  void area;
  if (stamp === undefined) return "workflow";
  return stamp.areas.flow === "core" ? "core" : "workflow";
}

/** The operation a developer task route path names (everything after `/v1/dev/tasks/<id>`), or undefined for a path that is not one. */
export function taskEntryOperation(rest: string): TaskEntryOperation | undefined {
  if (rest === "") return "read";
  if (!rest.startsWith("/")) return undefined;
  const name = rest.slice(1);
  if (/^people\/requests\/[^/]+$/u.test(name)) return "people/requests";
  if (/^readers(?:\/[^/]+)?$/u.test(name)) return "readers";
  if (name === "read" || name === "people/requests") return undefined;
  return Object.hasOwn(TASK_ENTRY_AREAS, name) ? name as TaskEntryOperation : undefined;
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERDICTS_MAX = 2_048;
const verdicts = new WeakMap<object, Map<string, Engine>>();

function remembered(table: EngineStateTable): { get(key: string): Engine | undefined } {
  const known = verdicts.get(table.documentClient);
  return { get: (key) => known?.get(`${table.tableName}\u0000${key}`) };
}

function remember(table: EngineStateTable, name: string, engine: Engine): void {
  let known = verdicts.get(table.documentClient);
  if (known === undefined) verdicts.set(table.documentClient, known = new Map<string, Engine>());
  const key = `${table.tableName}\u0000${name}`;
  // Bounded: when full, the oldest verdict goes (it is read again when next needed).
  if (known.size >= VERDICTS_MAX && !known.has(key)) known.delete(known.keys().next().value as string);
  known.set(key, engine);
}

async function readItem(table: EngineStateTable, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  // A strongly consistent read: a stamp is written in the same transaction as its task, so once the task is seen its stamp is too.
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/**
 * The task's stamp (undefined: none, which means the workflow). A read that fails throws, and so does a stamp item that is there but cannot be read as one: only the core's start
 * writes that item, so it is never taken for the workflow.
 */
export async function readTaskStamp(table: EngineStateTable, taskId: string): Promise<EngineStamp | undefined> {
  const item = await readItem(table, engineStampKey(taskId));
  if (item === undefined) return undefined;
  const stamp = stampOf(item);
  if (stamp === undefined) throw new Error("a task's engine stamp could not be read");
  return stamp;
}

/**
 * Who owns this operation of the task with this id, when it is not yet known whether the task exists (a route's first step). Only a `core` verdict is kept.
 * A malformed id is the workflow's (its own route answers it as it always has).
 */
export async function ownerOfTaskId(table: EngineStateTable, taskId: string, area: CoreArea = "flow"): Promise<Engine> {
  if (!TASK_ID.test(taskId)) return "workflow";
  const key = `task:${taskId}`;
  // A kept verdict is fixed (a `workflow` one is kept only for a task that exists).
  const known = remembered(table).get(key);
  if (known !== undefined) return known;
  const owner = entryOwner(await readTaskStamp(table, taskId), area);
  if (owner === "core") remember(table, key, owner);
  return owner;
}

/** Who owns the task, called only after its record was read and found: the verdict is then fixed and kept. */
export async function ownerOfExistingTask(table: EngineStateTable, taskId: string): Promise<Engine> {
  const key = `task:${taskId}`;
  const known = remembered(table).get(key);
  if (known !== undefined) return known;
  const owner = entryOwner(await readTaskStamp(table, taskId), "flow");
  remember(table, key, owner);
  return owner;
}

/**
 * Who owns a workspace's rows (its META, operations, artifacts, pull requests): the engine of the task whose pointer it holds. A workspace with no task pointer is no core task's
 * (every core start writes its pointer with the task), so it is the workflow's. Company discovery pointers require a live scoped META on every call; legacy workspace verdicts are kept.
 */
export async function ownerOfWorkspace(table: EngineStateTable, workspaceId: string): Promise<Engine> {
  const discovery = await readItem(table, { pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  if (discovery?.["entityType"] === "WORKSPACE_COMPANY_POINTER") {
    const company = OrgIdSchema.safeParse(discovery["companyId"]);
    if (!company.success) { logWorkspacePointerIntegrity(); throw agentXError("NOT_FOUND", "workspace unavailable"); }
    const scoped = await readItem(table, workspaceKey(company.data, workspaceId));
    if (scoped === undefined || scoped["companyId"] !== company.data || (scoped["orgId"] !== undefined && scoped["orgId"] !== company.data)) {
      logWorkspacePointerIntegrity();
      throw agentXError("NOT_FOUND", "workspace unavailable");
    }
    const pointer = await readItem(table, scopedTaskPointerKey(company.data, workspaceId));
    if (typeof pointer?.taskId !== "string" || !TASK_ID.test(pointer.taskId)) throw agentXError("NOT_FOUND", "workspace unavailable");
    return await ownerOfExistingTask(table, pointer.taskId);
  }
  const key = `workspace:${workspaceId}`;
  const known = remembered(table).get(key);
  if (known !== undefined) return known;
  const pointer = await readItem(table, taskPointerKey(workspaceId));
  if (pointer === undefined || typeof pointer.taskId !== "string") return "workflow";
  const owner = TASK_ID.test(pointer.taskId) ? await ownerOfExistingTask(table, pointer.taskId) : "workflow";
  remember(table, key, owner);
  return owner;
}

// ---- the core's own handlers, behind the developer task routes

/** The core's handlers for a developer task request, as the deployment composes them (the core host's dev routes over its caller mapping). Undefined: the core does not serve it. */
export interface CoreTaskEntry {
  route(request: BrokerRequest, caller: CoreEntryCaller): Promise<BrokerResponse | undefined>;
  /**
   * S2: the install administrator's cancel of a core task's workspace. The company is the workspace's own (its discovery pointer and scoped record), the task the one that workspace holds;
   * `authorize` is the admin route's own project check, asked with the task's project, and counts only for an administrator whose live membership is the task's company (Q2: a grant names a
   * project by name only). Throws the missing workspace's words for a workspace that is no core task's of a company on the core.
   * Absent: the deployment does not serve it (the admin route keeps its answer for a core workspace).
   */
  stopWorkspaceForAdmin?(workspaceId: string, administrator: { id: string }, authorize: (project: string) => Promise<void>): Promise<{ taskId: string; nothingRunning: boolean }>;
  /**
   * L4-U5b: remembers the chat conversation a core task was started from, so what the task later tells that conversation (`core/channel/thread-notices.ts`) has somewhere to go. The company is the CALLER'S live membership's,
   * the task must be one this caller may act on, and the conversation's tenant must belong to that company; anything else records nothing (`false`). Written once: a repeat changes nothing. Absent: the deployment keeps no thread.
   */
  recordThread?(caller: CoreEntryCaller, input: { taskId: string; conversation: ConversationRef; actor: ActorRef }): Promise<boolean>;
  /**
   * L4-U5d: a later message in the chat thread the task was started from, as input for that task (`core-host/chat-thread-input.ts`): an answer to Understand's questions, a note for the plan, or a follow-up note, under the
   * rule the web uses for a core task (the caller's live company, the thread's workspace that company's, the task's owner). A refusal writes nothing and is an answer, not a throw; a throw means nothing was saved (the chat retries).
   * Absent: the deployment takes no input from a thread.
   */
  threadInput?(caller: CoreEntryCaller, input: ChatThreadInput): Promise<ChatThreadInputResult>;
  /**
   * Core task web routes (Cloud #188 item 5): what one of the caller's own core tasks has cost and its limit, for the task list's detail. The company is the caller's live membership's and the task must be one they may
   * act on; `undefined` for anything else (and for any failure). Absent: the deployment gives the list no money for core tasks.
   */
  taskMoney?(caller: CoreEntryCaller, taskId: string): Promise<{ costUsd?: number; runLimitUsd: number } | undefined>;
  /**
   * Understand's round on the task list's detail: whether the core's own task read would show this caller the task (the owner, a co-owner or a reader of its People list, in their live company). `false` for anything else
   * and for any failure. Absent: the deployment gives the list no round for core tasks.
   */
  taskReadable?(caller: CoreEntryCaller, taskId: string): Promise<boolean>;
  /**
   * HW5b: a press of Approve (or the words typed for Request changes) on the plan card a core task's chat thread was given, as a request to the company's approval gate (`core-host/chat-decision.ts`): the caller is the person the broker
   * resolved from the chat account, and the core checks the account, the workspace, the card, the risk and the person's authority again. A refusal writes nothing and is an answer, not a throw; a throw means nothing was decided (the chat
   * may try again). Absent: the deployment takes no decision from a chat (the card is the sign-in card).
   */
  chatDecision?(caller: CoreEntryCaller, press: ChatDecisionPress): Promise<ChatDecisionResult>;
}

/**
 * S2: a Stop that reached the broker from somewhere other than the developer route (Slack's thread stop and Stop button), for a task the core owns: the core's own authorized stop
 * (`POST /v1/dev/tasks/{id}/cancel`, the task's owner or a live owner/admin of its company), as this caller, with a new request id. `stopped` only for the core's 200; any refusal, an
 * unreadable answer and a deployment without a core entry are `refused` (the caller says what a missing or not-yours task says), never the workflow's stop.
 */
export async function stopCoreTaskAs(entry: CoreTaskEntry | undefined, caller: CoreEntryCaller, taskId: string): Promise<"stopped" | "refused"> {
  if (entry === undefined || !TASK_ID.test(taskId)) return "refused";
  const answer = await entry.route({ method: "POST", path: `/v1/dev/tasks/${taskId}/cancel`, headers: {}, body: JSON.stringify({ requestId: randomUUID() }) }, caller);
  return answer?.statusCode === 200 ? "stopped" : "refused";
}

/**
 * The broker's signed-in caller as the core entry takes it. `amr` is how the person signed in, as the VERIFIED access token states it, set only by the broker's token sign-in; `clientId` is the
 * registered sign-in client whose token made the call (absent for the Rovara CLI).
 */
export interface CoreEntryCaller {
  developerId: string;
  sessionId: string;
  name: string;
  amr?: DeveloperSignInMethod | undefined;
  clientId?: string | undefined;
  /** DEC 236h: set by the broker's sign-in only for the Rovara web app's own sign-in client (`DeveloperCaller.webApp`), never from a request. Everything else that reads the wiki is a tool outside Rovara (L4-WKS). */
  webApp?: true | undefined;
}

/** The developer start route's path: a start is the core's only where the core's routes say so (`undefined` keeps the old start). */
const DEVELOPER_START = "/v1/dev/tasks";
const isStart = (request: BrokerRequest): boolean => request.method === "POST" && request.path.split("?")[0] === DEVELOPER_START;

/**
 * Composes the core host's dev routes (`createCoreDevRoutes`) as the developer task routes' core entry. `deployedCallerOf` is the deployment's identity mapping from the broker's
 * signed-in caller to the principal the core knows (lane ID): undefined, or a throw, answers the sign-in refusal the core's routes give. Nothing here picks a company: the core's
 * routes take it from membership.
 */
export function coreTaskEntryFrom(
  routes: { route(request: BrokerRequest, caller: DeployedCaller): Promise<BrokerResponse | undefined>; taskMoney?(caller: DeployedCaller, taskId: string): Promise<{ costUsd?: number; runLimitUsd: number } | undefined>; taskReadable?(caller: DeployedCaller, taskId: string): Promise<boolean> },
  deployedCallerOf: (caller: CoreEntryCaller) => Promise<DeployedCaller | undefined>,
  /** L4-U5b: the deployment's thread recording, asked with the caller as the core knows them (`deployedCallerOf`). Absent: the entry has no `recordThread`. */
  recordThread?: (deployed: DeployedCaller, input: { taskId: string; conversation: ConversationRef; actor: ActorRef }) => Promise<boolean>,
  /** L4-U5d: the deployment's thread input, asked with the caller as the core knows them. Absent: the entry has no `threadInput`. */
  threadInput?: (deployed: DeployedCaller, input: ChatThreadInput) => Promise<ChatThreadInputResult>,
  /** HW5b: the deployment's chat decision, asked with the caller as the core knows them. Absent: the entry has no `chatDecision`. */
  chatDecision?: (deployed: DeployedCaller, press: ChatDecisionPress) => Promise<ChatDecisionResult>,
): CoreTaskEntry {
  const taskMoney = routes.taskMoney?.bind(routes);
  const taskReadable = routes.taskReadable?.bind(routes);
  return {
    ...(taskReadable === undefined ? {} : {
      async taskReadable(caller: CoreEntryCaller, taskId: string) {
        let deployed: DeployedCaller | undefined;
        try { deployed = await deployedCallerOf(caller); } catch { return false; }
        if (deployed === undefined) return false;
        try { return (await taskReadable(deployed, taskId)) === true; } catch { return false; }
      },
    }),
    ...(chatDecision === undefined ? {} : {
      async chatDecision(caller: CoreEntryCaller, press: ChatDecisionPress): Promise<ChatDecisionResult> {
        // No membership is the same refusal as a person who may not: nothing is written.
        let deployed: DeployedCaller | undefined;
        try { deployed = await deployedCallerOf(caller); } catch { deployed = undefined; }
        if (deployed === undefined) return { outcome: "refused", reason: "not_approved" };
        return await chatDecision(deployed, press);
      },
    }),
    ...(threadInput === undefined ? {} : {
      async threadInput(caller: CoreEntryCaller, input: ChatThreadInput): Promise<ChatThreadInputResult> {
        // No membership is the same refusal as a person who may not: nothing is written.
        const deployed = await deployedCallerOf(caller);
        if (deployed === undefined) return { outcome: "refused", notice: "not_allowed" };
        return await threadInput(deployed, input);
      },
    }),
    ...(taskMoney === undefined ? {} : {
      async taskMoney(caller: CoreEntryCaller, taskId: string) {
        let deployed: DeployedCaller | undefined;
        try { deployed = await deployedCallerOf(caller); } catch { return undefined; }
        if (deployed === undefined) return undefined;
        try { return await taskMoney(deployed, taskId); } catch { return undefined; }
      },
    }),
    ...(recordThread === undefined ? {} : {
      async recordThread(caller: CoreEntryCaller, input: { taskId: string; conversation: ConversationRef; actor: ActorRef }): Promise<boolean> {
        let deployed: DeployedCaller | undefined;
        try { deployed = await deployedCallerOf(caller); } catch { return false; }
        if (deployed === undefined) return false;
        try { return await recordThread(deployed, input); } catch { return false; }
      },
    }),
    async route(request, caller) {
      let deployed: DeployedCaller | undefined;
      let unreadable = false;
      try {
        deployed = await deployedCallerOf(caller);
      } catch {
        deployed = undefined;
        unreadable = true;
      }
      // A start by a person the mapping names no company for is not the core's: the old start answers it, as before. A mapping that failed refuses it.
      if (deployed === undefined && !unreadable && isStart(request)) return undefined;
      if (deployed === undefined) return { statusCode: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in again." } }) };
      return await routes.route(request, deployed);
    },
  };
}

/** The developer routes' own sign-in refusal (developer-routes.ts SIGN_IN_AGAIN). */
const CORE_SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
const CORE_ANSWER_UNREADABLE = "The core engine's answer could not be read.";

/** The core's answer as the developer task routes return it: the value for a 200, else the AgentXError it names (a code outside the closed list, or a body that is not one, is a fixed error). */
export function coreAnswerValue(answer: BrokerResponse): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", CORE_ANSWER_UNREADABLE);
  }
  if (answer.statusCode === 200) return parsed;
  // The core's sign-in refusal is the developer routes' own.
  if (answer.statusCode === 401) throw agentXError("AUTH_REQUIRED", CORE_SIGN_IN_AGAIN);
  const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = AgentXErrorCodeSchema.safeParse(error?.code);
  if (!code.success || typeof error?.message !== "string") throw agentXError("RUNTIME_UNAVAILABLE", CORE_ANSWER_UNREADABLE);
  throw agentXError(code.data, error.message);
}

/**
 * A developer task route for a task the core owns. The core's handlers answer it when they serve it. When they do not (no core entry on this install, or an operation it has no handler
 * for), the core's own task read decides what may be said: someone it lets read the task is told the operation is not on the core here yet; anyone else gets `missing()`, which is the
 * developer route's own answer for an id with no task (input checks, wrong method and words included), so a core task's id answers exactly like an id with no task. Never falls back to
 * the workflow's readers for the task itself.
 */
export async function serveCoreTask(entry: CoreTaskEntry | undefined, request: BrokerRequest, caller: CoreEntryCaller, taskId: string, missing: () => Promise<unknown>): Promise<unknown> {
  if (entry === undefined) return await missing();
  const answer = await entry.route(request, caller);
  // The broker has already signed the caller in: a 401 or 404 from the core means only "not the core's to show this caller", which is a missing task's answer here.
  if (answer !== undefined) return answer.statusCode === 404 || answer.statusCode === 401 ? await missing() : coreAnswerValue(answer);
  if (request.method === "GET" && request.path.split("?")[0] === `/v1/dev/tasks/${taskId}`) return await missing();
  const read = await entry.route({ method: "GET", path: `/v1/dev/tasks/${taskId}`, headers: {}, ...(request.requestId === undefined ? {} : { requestId: request.requestId }) }, caller);
  if (read?.statusCode === 200) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
  return await missing();
}

/**
 * The developer start, through the core where the switch sends this caller's company (lane E2 step 6). `undefined`: the old start answers it (no core entry on this install, a company the
 * switch does not send to the core, or a person with no member company). Otherwise the core's answer, as the developer routes return it.
 */
export async function startOnCore(entry: CoreTaskEntry | undefined, request: BrokerRequest, caller: CoreEntryCaller): Promise<{ value: unknown } | undefined> {
  if (entry === undefined || !isStart(request)) return undefined;
  const answer = await entry.route(request, caller);
  return answer === undefined ? undefined : { value: coreAnswerValue(answer) };
}

/**
 * The developer list of the tasks the caller was added to (`GET /v1/dev/tasks?involved=1`, web task channel C5): the core's own answer. Tasks on the old workflow have no involved list (D6: new
 * web features are the core's only), so no core entry, a company the core does not serve and a caller the core does not know all read as an empty list, never an error and never the ordinary list.
 * The core re-checks every task against its live access; anything else it refuses (a bad `limit` or `cursor`) is passed on in its words.
 */
export async function involvedOnCore(entry: CoreTaskEntry | undefined, request: BrokerRequest, caller: CoreEntryCaller): Promise<unknown> {
  const none = { involved: true, tasks: [] };
  if (entry === undefined) return none;
  const answer = await entry.route(request, caller);
  if (answer === undefined || answer.statusCode === 401 || answer.statusCode === 404) return none;
  return coreAnswerValue(answer);
}
