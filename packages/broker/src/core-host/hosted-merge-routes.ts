// Owner DEC 254zzz94: the in-Rovara Merge button for a finished core task's pull requests on the hosted install, served AS the signed-in person:
//
//   GET  /v1/app/tasks/{taskId}/merge   { mayMerge, ready, message?, pullRequests }: whether this person may press Merge, and whether it would merge now (reads GitHub)
//   POST /v1/app/tasks/{taskId}/merge   { requestId }: merges every required open pull request of the task through GitHub's own merge API; answers { status: "MERGED", pullRequests }
//
// Rules (each refusal is fixed words; nothing a caller sent, no GitHub text and no token is ever echoed):
//   - WHERE: a press comes only from the Rovara website's own sign-in client (`webApp`, set by the broker's sign-in from the client's registration, never from a request; DEC 254zzz91). The CLI's
//     token or an AI tool's is refused with ON_THE_WEBSITE_MESSAGE before anything is read. A script token never reaches these paths (the dev routes refuse it first). Reading readiness is allowed anywhere.
//   - WHO: the task's owner or a People co-owner (the flow's own `canAct`, as every owner move), a live owner or admin of the task's company (membership's role, read for this request), or an
//     administrator (maintainer) of the task's project (the broker's project grant, read through the root's grant reader). Someone who may read the task but is none of these gets fixed words;
//     anyone else, another company's task and a task that does not exist all read "task not found", before anything else is read about the task.
//   - SAFETY: the task's workflow must be waiting for the merge with Rovara's own checks and reviews done (the merge core's `workflowRefusal`), and for every required open pull request GitHub's
//     fresh read must show it open, not a draft, at exactly the head Rovara checked, with its checks passing and GitHub saying it can merge (`mergeableState` clean or unstable). Only then is the
//     merge sent, through the code host port's `merge` (GitHub's `PUT pulls/{n}/merge` with the checked head as `sha`), so branch protection, required reviews and required checks still apply on
//     GitHub's side. Any refusal before that sends nothing to GitHub's merge endpoint.
//   - ONE MERGE AT A TIME, ONE ANSWER PER REQUEST: a press takes the task's merge lock (a conditional write in the company's own partition) and writes its result under its request id; the same
//     request id answers the stored result again without asking GitHub, and a request id another person used is refused.
//   - AUDIT: `task.merge_pressed` is recorded BEFORE GitHub is asked (no record, no merge), and `task.merge_result` after, with the pull requests, heads and outcome.
import { z } from "zod";
import {
  AgentXError, MERGE_NOT_READY_MESSAGES as M, ON_THE_WEBSITE_MESSAGE, agentXError, companyScoped, when,
  type AuditEvent, type AuditSink, type DocumentKey, type MergeResult, type OrgId, type OrgRole, type Principal,
} from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { loadReadableTask, readTask } from "../core/task-flow/reads.js";
import { taskNotFound } from "../core/task-flow/access.js";
import { requiredPullRequests, workflowRefusal } from "../core/merge/merge.js";
import { readCi } from "../core/merge/merge-tracking.js";
import { changeRequestRef, type RepositoryResolver } from "../core/merge/host-port.js";

/** `/v1/app/tasks/<uuid>/merge`. */
const HOSTED_MERGE_PATH = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/merge$/u;

/** Whether this method and path is the hosted Merge button's. */
export function isHostedMergePath(path: string, method: string): boolean {
  return HOSTED_MERGE_PATH.test(path) && (method === "GET" || method === "POST");
}

/** The audit actions this route writes. */
export const MERGE_PRESSED_AUDIT = "task.merge_pressed";
export const MERGE_RESULT_AUDIT = "task.merge_result";
/** How long a press holds the task's merge lock before another press may take it (a press that died mid-way). GitHub's merge itself is bounded at 15 s per pull request. */
export const MERGE_LOCK_MS = 120_000;
/** The most pull requests one press merges (the workflow's own limit). */
const MAX_PULL_REQUESTS = 32;

/** The fixed words of this route. */
export const HOSTED_MERGE_WORDS = {
  notAllowed: "Only the task's owner, a co-owner, a project admin or a company admin can merge this task.",
  notSetUp: "Merging from Rovara is not set up on this install yet; merge the pull request on GitHub.",
  body: "send a requestId (a UUID) and nothing else",
  headMoved: "The pull request has new commits since Rovara checked it. Wait for Rovara's checks on the new code, then press Merge again.",
  blocked: "GitHub isn't allowing this merge yet: a required review, a required check or a branch rule is not met. Check it on GitHub, then press Merge again.",
  behind: "The branch is behind its base and GitHub needs it up to date. Update the branch on GitHub, then press Merge again.",
  conflicted: "The branch conflicts with its base. Resolve the conflict on GitHub, then press Merge again.",
  noRepository: "Rovara couldn't find this pull request's repository in the project, so nothing was merged.",
  inProgress: "A merge of this task is already being made. Reload the page in a moment.",
  requestReused: "That request was already used by someone else. Reload the page and press Merge again.",
  unavailable: "Rovara couldn't reach GitHub just now, so nothing was merged. Try again in a minute.",
  outcomeUnknown: "Rovara asked GitHub to merge but did not hear back. Check the pull request on GitHub before pressing Merge again.",
} as const;

/** Why GitHub refused a merge, in fixed words (GitHub's own text is never shown). */
const REFUSAL_WORDS: Record<Extract<MergeResult, { outcome: "refused" }>["reason"], string> = {
  head_changed: "its code changed after Rovara checked it",
  not_mergeable: "GitHub would not merge it (a branch rule, a required review or a required check)",
  closed: "it was closed",
  forbidden: "Rovara's GitHub App is not allowed to merge it",
};

/** What the deployment wires for one company (the hosted root). Absent: both paths answer NOT_ON_THE_CORE_YET's sibling, `notSetUp`. */
export interface HostedMergeWiring {
  /** The person's grant on a project, through the root's existing grant reader (never raw keys here). `administrator` is a project admin (maintainer). A read that throws is "no grant". */
  projectGrantRole(personId: string, project: string): Promise<"developer" | "administrator" | undefined>;
  /** The repository of the task's project, by its pinned revision, with the code host its record names (`createRepositoryResolver`). */
  repository: RepositoryResolver;
  /** The project's merge method (its code settings; Code's default is squash). A read that throws refuses the press. */
  mergeMethod(companyId: OrgId, project: string): Promise<"squash" | "merge">;
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

const MergeBodySchema = z.object({ requestId: z.string().uuid() }).strict();

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notReady = (message: string): AgentXError => agentXError("MERGE_NOT_READY", message);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", HOSTED_MERGE_WORDS.body); }
}

type Basis = "task-owner" | "company-admin" | "project-admin";

/**
 * Who the caller is to the task: `may` (with the basis), `reader` (may read it, may not merge), or not found. The task must be of the caller's OWN company (membership's), checked before any
 * rule is asked. Each live read that throws counts as "no".
 */
async function standingOf(input: HostedMergeInput, taskId: string): Promise<{ task: TaskRecord; may: Basis | undefined }> {
  const { flow, companyId, principal } = input;
  if (principal.companyId !== companyId || flow.companyId !== companyId) throw taskNotFound();
  const task = await readTask(flow, taskId);
  if (task === undefined || task.companyId !== companyId) throw taskNotFound();
  if (await flow.access.canAct(principal, task).catch(() => false)) return { task, may: "task-owner" };
  if (input.role === "owner" || input.role === "admin") return { task, may: "company-admin" };
  const grant = await input.wiring?.projectGrantRole(principal.personId, task.project).catch(() => undefined);
  if (grant === "administrator") return { task, may: "project-admin" };
  // Not one of them: a reader of the task is told so; anyone else reads exactly as for a missing task.
  await loadReadableTask(flow, { principal }, taskId);
  return { task, may: undefined };
}

interface PullToMerge { repositoryId: string; number: number; url: string; headSha: string; homeUrl: string; merge: NonNullable<Awaited<ReturnType<RepositoryResolver>>>["codeHost"]["merge"]; alreadyMerged: boolean }

/** The task's required pull requests that are not merged in Rovara's record, as the readiness answer lists them. */
function openPullRequestsOf(task: TaskRecord): Array<{ repositoryId: string; number: number; url: string; headSha?: string | undefined }> {
  if (task.workflow === undefined) return [];
  return requiredPullRequests(task.workflow).filter((entry) => entry.state !== "MERGED").slice(0, MAX_PULL_REQUESTS)
    .map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number, url: entry.url, ...(entry.headSha === undefined ? {} : { headSha: entry.headSha }) }));
}

/**
 * Whether the task would merge now: Rovara's workflow rule, then a FRESH GitHub read of every required open pull request. Throws MERGE_NOT_READY with fixed words, or RUNTIME_UNAVAILABLE when
 * GitHub or the repository record cannot be read. Never merges anything.
 */
async function readiness(input: HostedMergeInput, wiring: HostedMergeWiring, task: TaskRecord): Promise<PullToMerge[]> {
  const workflow = task.workflow;
  if (workflow === undefined) throw notReady(M.changing);
  const refusal = workflowRefusal(workflow);
  if (refusal !== undefined) throw notReady(refusal);
  const open = openPullRequestsOf(task);
  if (open.length === 0) throw notReady(M.taskClosed);
  const several = open.length > 1;
  const scope = { orgId: input.companyId };
  const pulls: PullToMerge[] = [];
  for (const entry of open) {
    const say = (reason: string): AgentXError => notReady(several ? M.repository(entry.repositoryId, reason) : reason);
    if (entry.headSha === undefined) throw say(M.changing);
    let home: Awaited<ReturnType<RepositoryResolver>>;
    try { home = await wiring.repository(task.project, task.startingRevision, entry.repositoryId, input.companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable); }
    if (home === undefined) throw say(HOSTED_MERGE_WORDS.noRepository);
    if (home.codeHost.merge === undefined) throw agentXError("NOT_FOUND", HOSTED_MERGE_WORDS.notSetUp);
    let status: Awaited<ReturnType<typeof home.codeHost.changeRequestStatus>>;
    try { status = await home.codeHost.changeRequestStatus(changeRequestRef(home.url, entry.number), scope); } catch { throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable); }
    const base = { repositoryId: entry.repositoryId, number: entry.number, url: entry.url, headSha: entry.headSha, homeUrl: home.url, merge: home.codeHost.merge.bind(home.codeHost) };
    if (status.state === "merged") { pulls.push({ ...base, alreadyMerged: true }); continue; }
    if (status.state !== "open") throw say(M.notOpen);
    if (status.draft || status.mergeableState === "draft") throw say(M.draft);
    if (status.headRevision !== entry.headSha) throw say(HOSTED_MERGE_WORDS.headMoved);
    const ci = readCi(status, { checksEverSeen: true, lastRovaraPushAt: undefined, now: input.now() }).ci;
    if (ci === "unreadable") throw say(M.ciNotReadable);
    if (ci !== "passing") throw say(M.checks);
    if (status.mergeable === false || status.mergeableState === "conflicted") throw say(HOSTED_MERGE_WORDS.conflicted);
    if (status.mergeableState === "behind") throw say(HOSTED_MERGE_WORDS.behind);
    if (status.mergeableState === "blocked") throw say(HOSTED_MERGE_WORDS.blocked);
    if (status.mergeableState !== "clean" && status.mergeableState !== "unstable") throw say(M.notTrackedYet);
    pulls.push({ ...base, alreadyMerged: false });
  }
  return pulls;
}

/** The task's merge lock and each press's answer, in the company's own HOSTED_MERGE partition (the task id and request id are validated UUIDs). */
const lockKey = (companyId: OrgId, taskId: string): DocumentKey => ({ pk: companyScoped(companyId, "HOSTED_MERGE"), sk: `${taskId}#LOCK` });
const resultKey = (companyId: OrgId, taskId: string, requestId: string): DocumentKey => ({ pk: companyScoped(companyId, "HOSTED_MERGE"), sk: `${taskId}#REQUEST#${requestId}` });

const DoneSchema = z.object({ personId: z.string(), status: z.literal("MERGED"), pullRequests: z.array(z.object({ repositoryId: z.string(), number: z.number().int() }).strict()).max(MAX_PULL_REQUESTS) });

async function press(input: HostedMergeInput, wiring: HostedMergeWiring, taskId: string, basis: Basis, task: TaskRecord): Promise<BrokerResponse> {
  const parsed = MergeBodySchema.safeParse(bodyOf(input.request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", HOSTED_MERGE_WORDS.body);
  const { requestId } = parsed.data;
  const { companyId, principal, flow } = input;
  const personId = principal.personId;
  // The same request again: the stored answer, without asking GitHub. Another person's request id: refused.
  const stored = await flow.store.get(resultKey(companyId, taskId, requestId));
  if (stored !== undefined) {
    const done = DoneSchema.safeParse(stored);
    if (!done.success || done.data.personId !== personId) throw agentXError("IDEMPOTENCY_CONFLICT", HOSTED_MERGE_WORDS.requestReused);
    return json(200, { status: "MERGED", pullRequests: done.data.pullRequests });
  }
  // Every rule before the lock, so a refused press holds nothing.
  const pulls = await readiness(input, wiring, task);
  let method: "squash" | "merge";
  try { method = await wiring.mergeMethod(companyId, task.project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable); }
  if (method !== "squash" && method !== "merge") throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable);
  const now = input.now();
  const lock = await flow.store.put({
    item: { ...lockKey(companyId, taskId), entityType: "HOSTED_MERGE_LOCK", companyId, taskId, requestId, personId, until: now + MERGE_LOCK_MS },
    condition: when.or(when.absent(), when.lt("until", now)),
  });
  if (!lock.applied) throw agentXError("MERGE_NOT_READY", HOSTED_MERGE_WORDS.inProgress);
  const release = async (): Promise<void> => { await flow.store.delete({ key: lockKey(companyId, taskId), condition: when.eq("requestId", requestId) }).catch(() => undefined); };
  const subject = pulls.map((pull) => ({ repositoryId: pull.repositoryId, number: pull.number, headSha: pull.headSha }));
  const event = (action: string, details: Record<string, unknown>): AuditEvent => ({
    eventId: `${action}:${companyId}:${taskId}:${requestId}`, companyId, at: new Date(input.now()).toISOString(),
    actor: { type: "person", id: personId }, action, subject: { type: "task", id: taskId }, details: { basis, requestId, method, pullRequests: subject, ...details },
  });
  try {
    await input.audit.record(event(MERGE_PRESSED_AUDIT, {}));
  } catch {
    await release();
    throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable);
  }
  const merged: Array<{ repositoryId: string; number: number }> = [];
  let failure: AgentXError | undefined;
  for (const pull of pulls) {
    if (pull.alreadyMerged) { merged.push({ repositoryId: pull.repositoryId, number: pull.number }); continue; }
    let result: MergeResult;
    try {
      result = await pull.merge!(changeRequestRef(pull.homeUrl, pull.number), { revision: pull.headSha, method }, { orgId: companyId });
    } catch {
      failure = agentXError("RUNTIME_UNAVAILABLE", merged.length === 0 ? HOSTED_MERGE_WORDS.outcomeUnknown : M.halfMerged(merged.map((p) => `${p.repositoryId} #${String(p.number)}`).join(", "), `${pull.repositoryId} #${String(pull.number)}`, "GitHub did not answer"));
      break;
    }
    if (result.outcome === "merged" || result.outcome === "already_merged") { merged.push({ repositoryId: pull.repositoryId, number: pull.number }); continue; }
    const reason = REFUSAL_WORDS[result.reason] ?? REFUSAL_WORDS.not_mergeable;
    failure = notReady(merged.length === 0 ? M.notMerged(pull.repositoryId, reason) : M.halfMerged(merged.map((p) => `${p.repositoryId} #${String(p.number)}`).join(", "), `${pull.repositoryId} #${String(pull.number)}`, reason));
    break;
  }
  const outcome = failure === undefined ? "merged" : merged.length === 0 ? "refused" : "half_merged";
  await input.audit.record(event(MERGE_RESULT_AUDIT, { outcome, merged })).catch(() => input.log?.({ event: "hosted_merge.audit_result_failed", companyId, taskId }));
  if (failure !== undefined) { await release(); throw failure; }
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
    const { task, may } = await standingOf(input, taskId);
    const pullRequests = openPullRequestsOf(task).map((pull) => ({ repositoryId: pull.repositoryId, number: pull.number, url: pull.url }));
    if (!pressing) {
      if (may === undefined) return json(200, { mayMerge: false, ready: false, pullRequests });
      try {
        await readiness(input, wiring, task);
        return json(200, { mayMerge: true, ready: true, pullRequests });
      } catch (error) {
        if (error instanceof AgentXError && (error.code === "MERGE_NOT_READY" || error.code === "RUNTIME_UNAVAILABLE" || error.code === "NOT_FOUND")) {
          return json(200, { mayMerge: true, ready: false, message: error.message.slice(error.code.length + 2), pullRequests });
        }
        throw error;
      }
    }
    if (may === undefined) throw agentXError("FORBIDDEN", HOSTED_MERGE_WORDS.notAllowed);
    return await press(input, wiring, taskId, may, task);
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    input.log?.({ event: "hosted_merge.failed", error: error instanceof Error ? error.name : "unknown" });
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_WORDS.unavailable));
  }
}
