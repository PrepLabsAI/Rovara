// Owner DEC 254zzz94 (and 254zzz104): the in-Rovara Merge button for a finished core task's pull requests on the hosted install, served AS the signed-in person:
//
//   GET  /v1/app/tasks/{taskId}/merge   { mayMerge, ready, message?, risk?, heads?, pullRequests }: whether this person may press Merge, and whether it would merge now (the merge core's view, from what
//                                        tracking last read), with the heads and the risk level a press would merge at
//   POST /v1/app/tasks/{taskId}/merge   { requestId, expectedHeads?, risk? }: merges the task's pull requests through the merge core; what the person was shown (heads, risk) must still be what merges
//
// What this file decides, and nothing else (every merge rule is the merge core's, core/merge/merge.ts `pressMergeAsPerson`, which runs every gate `pressMerge` runs except the approver proof):
//   - WHERE: a press comes only from the Rovara website's own sign-in client (`webApp`, set by the broker's sign-in from the client's registration, never from a request; DEC 254zzz91). The CLI's token or an
//     AI tool's is refused with ON_THE_WEBSITE_MESSAGE before anything is read. A script token never reaches these paths (the dev routes refuse it first). Reading readiness is allowed anywhere.
//   - WHO (replaces the approver proof, DEC 254zzz104): the task's owner or a People co-owner (the flow's own `canAct`, as every owner move), a live owner or admin of the task's company (membership's role,
//     read for this request; kept by the owner), or an administrator (maintainer) of the task's project (the broker's project grant, read through the root's grant reader). Someone who may read the task but is
//     none of these gets fixed words; anyone else, another company's task and a task that does not exist all read "no such task", before anything else is read about the task.
//   - ONE MERGE AT A TIME, ONE ANSWER PER REQUEST: a press takes the task's merge lock (a conditional write in the company's own partition, held long enough for the longest merge) and writes its result under
//     its request id; the same request id answers the stored result again without asking GitHub, and a request id another person used is refused. The core also claims each pull request on its tracking item.
//   - AUDIT: `task.merge_pressed` is recorded BEFORE the merge core runs (no record, no merge), and `task.merge_result` after; each attempt has its own event id. The core stages `pull_request.merge_requested` with
//     each claim. After a merge the task's tracking row is made due now, so the next sweep records the merge in the workflow.
//   - Refusals are the merge core's fixed words or this file's; nothing a caller sent and no token is echoed. The core's "didn't merge" words may carry GitHub's own reason, cleaned and cut by the
//     GitHub client (`githubReasonOf`), shown only to someone who may merge this task.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentXError, MERGE_NOT_READY_MESSAGES as M, ON_THE_WEBSITE_MESSAGE, agentXError, companyScoped, when,
  type AuditEvent, type AuditSink, type DocumentKey, type OrgId, type OrgRole, type Principal,
} from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { loadReadableTask, readTask } from "../core/task-flow/reads.js";
import { taskNotFound } from "../core/task-flow/access.js";
import { SCOPE_HELD, mergeViewOf, pressMergeAsPerson, requiredPullRequests, type MergeDependencies } from "../core/merge/merge.js";
import { readMergeTracking } from "../core/merge/store.js";
import { scopeHoldOf } from "../core/build-step/scope-question.js";
import { mergeTaskOf } from "../services/merge-tracking.js";

/** `/v1/app/tasks/<uuid>/merge`. */
const HOSTED_MERGE_PATH = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/merge$/u;

/** Whether this method and path is the hosted Merge button's. */
export function isHostedMergePath(path: string, method: string): boolean {
  return HOSTED_MERGE_PATH.test(path) && (method === "GET" || method === "POST");
}

/** The audit actions this route writes. */
export const MERGE_PRESSED_AUDIT = "task.merge_pressed";
export const MERGE_RESULT_AUDIT = "task.merge_result";
/** The most pull requests one press merges (the workflow's own limit). */
const MAX_PULL_REQUESTS = 32;
/** How long a press holds the task's merge lock before another press may take it (a press that died mid-way): every pull request's merge (15 s each at most) plus the reads around them, with room to spare. */
export const MERGE_LOCK_MS = 15 * 60_000;

/** The fixed words of this route. */
export const HOSTED_MERGE_WORDS = {
  notAllowed: "Only the task's owner, a co-owner, a project admin or a company admin can merge this task.",
  notSetUp: "Merging from Rovara is not set up on this install yet; merge the pull request on GitHub.",
  body: "send a requestId (a UUID) and, if you were shown them, the heads and the risk level; nothing else",
  inProgress: "A merge of this task is already being made. Reload the page in a moment.",
  requestReused: "That request was already used by someone else. Reload the page and press Merge again.",
  unavailable: "Rovara couldn't reach GitHub just now, so nothing was merged. Try again in a minute.",
  notRecorded: "Rovara couldn't record the merge just now, so nothing was merged. Try again in a minute.",
} as const;

/** What the deployment wires for one company (the hosted root). Absent: both paths say merging from Rovara is not set up. */
export interface HostedMergeWiring {
  /** The person's grant on a project, through the root's existing grant reader (never raw keys here). `administrator` is a project admin (maintainer). A read that throws is "no grant". */
  projectGrantRole(personId: string, project: string): Promise<"developer" | "administrator" | undefined>;
  /** The merge core's dependencies for this company (every gate's seam; `requirePassingCi` on), with this request's audit sink. Throws when the install cannot build them (the route then says not set up). */
  merge(audit: AuditSink): MergeDependencies;
  /** Makes the task's tracking row due now (`wakeMergeTracking`), after a merge. Best effort. */
  afterMerge(taskId: string): Promise<void>;
}

export interface HostedMergeInput {
  request: BrokerRequest;
  path: string;
  principal: Principal;
  /** The caller's company and live role, from membership (the dev routes' `companyOf`), never a request. */
  companyId: OrgId;
  role: OrgRole;
  flow: TaskFlowDeps;
  wiring: HostedMergeWiring | undefined;
  audit: AuditSink;
  now: () => number;
  /** Owner DEC 254zzz91: the caller is the Rovara website's own client (set by the broker's sign-in, never from a request). */
  webApp?: boolean | undefined;
  log?: (entry: Record<string, unknown>) => void;
}

const HeadSchema = z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict();
const MergeBodySchema = z.object({ requestId: z.string().uuid(), expectedHeads: z.array(HeadSchema).min(1).max(MAX_PULL_REQUESTS).optional(), risk: z.enum(["low", "medium", "high"]).optional() }).strict();

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const wordsOf = (error: AgentXError): string => error.message.slice(error.code.length + 2);
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: wordsOf(error) } });

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", HOSTED_MERGE_WORDS.body); }
}

type Basis = "task-owner" | "company-admin" | "project-admin";

/**
 * Who the caller is to the task: `may` (with the basis), or a reader who may not merge (`may` undefined); anyone else reads "no such task". The task must be of the caller's OWN company (membership's), checked
 * before any rule is asked. Each live read that throws counts as "no".
 */
async function standingOf(input: HostedMergeInput, wiring: HostedMergeWiring, taskId: string): Promise<{ task: TaskRecord; may: Basis | undefined }> {
  const { flow, companyId, principal } = input;
  if (principal.companyId !== companyId || flow.companyId !== companyId) throw taskNotFound();
  const task = await readTask(flow, taskId);
  if (task === undefined || task.companyId !== companyId) throw taskNotFound();
  if (await flow.access.canAct(principal, task).catch(() => false)) return { task, may: "task-owner" };
  if (input.role === "owner" || input.role === "admin") return { task, may: "company-admin" };
  const grant = await wiring.projectGrantRole(principal.personId, task.project).catch(() => undefined);
  if (grant === "administrator") return { task, may: "project-admin" };
  // Not one of them: a reader of the task is told so; anyone else reads exactly as for a missing task.
  await loadReadableTask(flow, { principal }, taskId);
  return { task, may: undefined };
}

/** The task's required pull requests not merged in Rovara's record, as the answers list them. */
function openPullRequestsOf(task: TaskRecord): Array<{ repositoryId: string; number: number; url: string }> {
  if (task.workflow === undefined) return [];
  return requiredPullRequests(task.workflow).filter((entry) => entry.state !== "MERGED").slice(0, MAX_PULL_REQUESTS).map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number, url: entry.url }));
}

function depsOf(wiring: HostedMergeWiring, audit: AuditSink): MergeDependencies {
  try { return wiring.merge(audit); } catch { throw agentXError("NOT_FOUND", HOSTED_MERGE_WORDS.notSetUp); }
}

/** The merge core's view for this person, from what tracking last read (nothing is read from GitHub here), with the scope hold the press also checks. */
type Readiness = { ready: boolean; message?: string; risk?: "low" | "medium" | "high"; heads?: Array<{ repositoryId: string; number: number; headSha: string }> };
async function readinessView(input: HostedMergeInput, deps: MergeDependencies, record: TaskRecord): Promise<Readiness> {
  const task = mergeTaskOf(record, input.companyId);
  if (task === undefined || task.workflow === undefined) return { ready: false, message: M.changing };
  if (task.closedAt !== undefined || task.releasedAt !== undefined) return { ready: false, message: M.taskClosed };
  if (await scopeHoldOf({ store: deps.store }, task)) return { ready: false, message: SCOPE_HELD };
  const items = await readMergeTracking(deps.store, task.taskId, input.companyId);
  const view = await mergeViewOf(deps, task, items, input.principal.personId);
  if (view === undefined) return { ready: false, message: M.notTrackedYet };
  // What a press would merge at: the heads tracking holds for the pull requests not merged yet, and the risk level. The page sends them back with the press.
  const heads = items.filter((item) => item.state !== "merged").slice(0, MAX_PULL_REQUESTS).map((item) => ({ repositoryId: item.repositoryId, number: item.number, headSha: item.headSha }));
  const shown = { ...(view.risk === undefined ? {} : { risk: view.risk.level }), heads };
  return view.ready ? { ready: true, ...shown } : { ready: false, ...(view.message === undefined ? {} : { message: view.message }), ...shown };
}

/** Whether a refusal is the core's half merge (some pull request merged, another did not). */
const HALF_MERGED = M.halfMerged("\u0000", "\u0001", "\u0002").split("\u0000")[1]!.split("\u0001")[0]!;
const halfMerged = (error: AgentXError): boolean => error.code === "MERGE_NOT_READY" && wordsOf(error).includes(HALF_MERGED);

const lockKey = (companyId: OrgId, taskId: string): DocumentKey => ({ pk: companyScoped(companyId, "HOSTED_MERGE"), sk: `${taskId}#LOCK` });
const resultKey = (companyId: OrgId, taskId: string, requestId: string): DocumentKey => ({ pk: companyScoped(companyId, "HOSTED_MERGE"), sk: `${taskId}#REQUEST#${requestId}` });

const DoneSchema = z.object({ personId: z.string(), status: z.literal("MERGED"), pullRequests: z.array(z.object({ repositoryId: z.string(), number: z.number().int() }).strict()).max(MAX_PULL_REQUESTS) });

async function press(input: HostedMergeInput, wiring: HostedMergeWiring, taskId: string, basis: Basis): Promise<BrokerResponse> {
  const parsed = MergeBodySchema.safeParse(bodyOf(input.request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", HOSTED_MERGE_WORDS.body);
  const { requestId, expectedHeads, risk } = parsed.data;
  const { companyId, principal, flow } = input;
  const personId = principal.personId;
  // The same request again: the stored answer, without asking GitHub. Another person's request id: refused.
  const stored = await flow.store.get(resultKey(companyId, taskId, requestId));
  if (stored !== undefined) {
    const done = DoneSchema.safeParse(stored);
    if (!done.success || done.data.personId !== personId) throw agentXError("IDEMPOTENCY_CONFLICT", HOSTED_MERGE_WORDS.requestReused);
    return json(200, { status: "MERGED", pullRequests: done.data.pullRequests });
  }
  const deps = depsOf(wiring, input.audit);
  const now = input.now();
  const lock = await flow.store.put({
    item: { ...lockKey(companyId, taskId), entityType: "HOSTED_MERGE_LOCK", companyId, taskId, requestId, personId, until: now + MERGE_LOCK_MS },
    condition: when.or(when.absent(), when.lt("until", now)),
  });
  if (!lock.applied) throw agentXError("MERGE_NOT_READY", HOSTED_MERGE_WORDS.inProgress);
  const release = async (): Promise<void> => { await flow.store.delete({ key: lockKey(companyId, taskId), condition: when.eq("requestId", requestId) }).catch(() => undefined); };
  // Each attempt has its own event id (a refused press may be sent again with the same request id).
  const attempt = randomUUID();
  const event = (action: string, details: Record<string, string | number | boolean | null | Array<Record<string, string | number>>>): AuditEvent => ({
    eventId: `${action}:${companyId}:${taskId}:${requestId}:${attempt}`, companyId, at: new Date(input.now()).toISOString(),
    actor: { type: "person", id: personId }, action, subject: { type: "task", id: taskId }, details: { basis, requestId, ...details },
  });
  try {
    await input.audit.record(event(MERGE_PRESSED_AUDIT, {}));
  } catch {
    await release();
    throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.notRecorded);
  }
  let merged: Array<{ repositoryId: string; number: number }>;
  try {
    // The task is read again inside the core, after the lock: every gate runs on the task as it is now.
    merged = (await pressMergeAsPerson(deps, { taskId, requestId, presserPersonId: personId, ...(expectedHeads === undefined ? {} : { expectedHeads }), ...(risk === undefined ? {} : { risk }) })).pullRequests;
  } catch (error) {
    await input.audit.record(event(MERGE_RESULT_AUDIT, { outcome: error instanceof AgentXError ? error.code : "failed" })).catch(() => input.log?.({ event: "hosted_merge.audit_result_failed", companyId, taskId }));
    await release();
    // After a half merge (some pull request merged) tracking finds out what GitHub holds now; a plain refusal changed nothing, so nothing is woken.
    if (error instanceof AgentXError && halfMerged(error)) await wiring.afterMerge(taskId).catch(() => undefined);
    if (error instanceof AgentXError) throw error.code === "NOT_FOUND" ? taskNotFound() : error;
    input.log?.({ event: "hosted_merge.failed", error: error instanceof Error ? error.name : "unknown" });
    throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable);
  }
  await input.audit.record(event(MERGE_RESULT_AUDIT, { outcome: "merged", merged })).catch(() => input.log?.({ event: "hosted_merge.audit_result_failed", companyId, taskId }));
  await wiring.afterMerge(taskId).catch(() => undefined);
  // The answer is kept under the request id (once), and the lock is given back in the same write.
  await flow.store.transact([
    { kind: "put", item: { ...resultKey(companyId, taskId, requestId), entityType: "HOSTED_MERGE_RESULT", companyId, taskId, personId, status: "MERGED", pullRequests: merged, at: new Date(input.now()).toISOString() }, condition: when.absent() },
    { kind: "delete", key: lockKey(companyId, taskId), condition: when.eq("requestId", requestId) },
  ]).catch(async () => { input.log?.({ event: "hosted_merge.result_not_kept", companyId, taskId }); await release(); });
  return json(200, { status: "MERGED", pullRequests: merged });
}

/** One request on the hosted Merge path (`isHostedMergePath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedMerge(input: HostedMergeInput): Promise<BrokerResponse> {
  try {
    const match = HOSTED_MERGE_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    const taskId = match[1]!;
    const pressing = input.request.method === "POST";
    if (!pressing && input.request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    // WHERE first: a press from anything but the Rovara website is refused before anything is read.
    if (pressing && input.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
    const wiring = input.wiring;
    if (wiring === undefined) throw agentXError("NOT_FOUND", HOSTED_MERGE_WORDS.notSetUp);
    const { task, may } = await standingOf(input, wiring, taskId);
    if (!pressing) {
      const pullRequests = openPullRequestsOf(task);
      if (may === undefined) return json(200, { mayMerge: false, ready: false, pullRequests });
      const view = await readinessView(input, depsOf(wiring, input.audit), task);
      return json(200, { mayMerge: true, ...view, pullRequests });
    }
    if (may === undefined) throw agentXError("FORBIDDEN", HOSTED_MERGE_WORDS.notAllowed);
    return await press(input, wiring, taskId, may);
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    input.log?.({ event: "hosted_merge.failed", error: error instanceof Error ? error.name : "unknown" });
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable));
  }
}
