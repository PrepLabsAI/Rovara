// Core task web routes (Cloud #188 item 3): the old task routes that a task the CORE owns had no answer for, served for it with the old routes' EXACT access rules. The paths, methods, request and answer shapes are
// the old ones (aws/developer-tasks.ts `routeDeveloperTaskRequest`), so the web app calls the same route for a task of either engine:
//   - People: `GET .../people` ({ view }), `GET .../people/candidates` ({ candidates }), `POST .../people/add`, `POST .../people/role`, `POST .../people/take-ownership` and `GET .../people/requests/{requestId}`
//     ({ change }). Each is the very same People function the old route calls (developer/task-people.ts, task-people-effects.ts): its own proof of who may read, manage or take over, its revision fence, its
//     propose -> confirm step. The People rows of a task are the task's own whichever engine runs it, and the core's owner and read rules already read them (aws/core-engine-root.ts `hostedTaskAccess`).
//   - Readers (spec 067): `GET .../readers`, `PUT` and `DELETE .../readers/{developerId}`. The old rule: the task's own person (its developer id) lists, shares and unshares; a reader it is shared with is told only
//     the owner may; anyone else reads no such task. The same reader rows and functions (aws/task-readers.ts).
//   - The events timeline: `GET .../events` ({ events }). Who may read: the one read rule (core/task-flow/read-rule.ts). A core task
//     has no workflow operation events, so its timeline is made from what the core records: its log (core/task-log: milestones, the plan summary, questions and answers, pull requests) and its workflow's
//     decisions, newest `limit` (default 10, at most 50), oldest first, each one line of fixed words around redacted, cut text.
//   - Plan comments: `GET .../comments` ({ comments }). The old rule (task-code-routes.ts `accessFor` with `read`, through `resolveCoreTaskAccess`, the same function) and the same comment rows.
// Before any of this, the core has read the task from the caller's OWN company (live membership, never the request) and refused anyone else as a missing task (core-host/dev-routes.ts). The person is the one the
// broker's sign-in vouched for (the core's principal, whose id is the developer id on a deployed install); a script token never reaches here.
import {
  DEVELOPER_EVENTS_DEFAULT, DEVELOPER_EVENTS_MAX, DEVELOPER_EVENT_TEXT_MAX, TaskPeopleAddRequestSchema, type TaskPeopleView, TaskPeopleRoleRequestSchema, TaskPeopleTakeOwnershipRequestSchema, agentXError, redactText,
  type DeveloperTaskEvent, type DocumentStore, type OrgId, type TaskLogEntry, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { z } from "zod";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import { grantTaskReader, holdsOwnTask, listTaskReaders, readerShare, revokeTaskReader } from "./task-readers.js";
import { getTaskPeople } from "../developer/task-people.js";
import { addTaskWebPerson, confirmTaskPeopleProposal, getTaskPeopleCandidates, getTaskPeopleProposal, proposeTaskOwnership, proposeTaskPeopleRole } from "../developer/task-people-effects.js";
import { createCorePlanComment, listCorePlanComments, readCoreTaskDiffPage } from "../developer/task-code-routes.js";
import { resolveCoreTaskAccess } from "../developer/task-access.js";
import type { TaskReadDecision, TaskReadSeams, TaskRead } from "../core/task-flow/read-rule.js";
import type { ArtifactReader } from "../core/task-flow/deps.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { readTaskLog } from "../core/task-log/store.js";
import { coreTaskRuleOf } from "../core-host/task-rule-paths.js";

export interface CoreTaskRuleRouteInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  /** The person the broker's sign-in vouched for: their developer id (the core principal's person id on a deployed install) and name. */
  person: { developerId: string; name: string };
  /** The caller's live company (membership's), which the task was read from and checked against. */
  companyId: OrgId;
  /** The task's own record, as the core read it from that company. */
  task: Record<string, unknown>;
  /** The company's own store (its task log). */
  store: Pick<DocumentStore, "query">;
  /**
   * The ONE read rule (core/task-flow/read-rule.ts `decideTaskRead`), bound by the core host to this caller and task: whether this person may read this task for `read`. Resolves with the decision, throws the refusal.
   * `seams` adds the old rules only this file can build (the People page rule of the diff).
   */
  authorize(read: TaskRead, seams?: TaskReadSeams): Promise<TaskReadDecision>;
}

export interface CoreTaskRuleRoutes {
  route(input: CoreTaskRuleRouteInput): Promise<BrokerResponse>;
  /** DEC 254zzz44 (a): the stored share (spec 067, `readerShare`) of this person on a task of this company: its role as stored, while they are still a member of the task's project. The read rule decides what it shows. */
  sharedReader(input: Pick<CoreTaskRuleRouteInput, "person" | "companyId" | "task">): Promise<{ role: string } | undefined>;
  /** The old People page rule (`pageRule`) as the read rule's seam, for a person and a task of this company: resolves when it admits, throws its refusal, says `viaChannelShare` for a person who reads only because the task is shared into their channel. */
  peoplePage(input: Pick<CoreTaskRuleRouteInput, "person" | "companyId" | "task">): Promise<void | { holdsOwnTask: true } | { viaChannelShare: true }>;
  /**
   * The task's own person's live hold on their task (the hotfix's test, one implementation: the grant, or the access that let them start it, a bound-channel member where the project lets channel members use it), read now,
   * for a task of this company. The read rule's live-grant seam asks it for the task's own person; anyone else it asks for the grant. A read that fails is "no".
   */
  holdsOwnTask(input: Pick<CoreTaskRuleRouteInput, "person" | "companyId" | "task">): Promise<boolean>;
  /** S1: the People moves of the task action registry, in process (the same People functions the routes call): the view, and taking over a task nobody owns (the propose step, then the confirm step, each re-reading the revision and the person's right). */
  people: {
    view(input: Pick<CoreTaskRuleRouteInput, "person" | "companyId" | "task">): Promise<TaskPeopleView>;
    takeOwnership(input: Pick<CoreTaskRuleRouteInput, "person" | "companyId" | "task"> & { requestId: string; expectedPeopleRevision: number }): Promise<void>;
  };
}

const json = (value: unknown): BrokerResponse => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

/** The old routes' segment decode: a malformed escape is kept as it was (the rule after it refuses it). */
function safeDecode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** The old routes' body: JSON (none is `{}`), or the old refusal. */
function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

/** The old routes' parse: the field's name and the schema's words, never the value. */
function parse<T>(schema: z.ZodType<T>, body: unknown, log: ((entry: Record<string, unknown>) => void) | undefined, route: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "body";
  log?.({ event: "developer.task_request_invalid", route, field });
  throw agentXError("CONFIG_INVALID", `${field}: ${issue?.message ?? "invalid"}`);
}

/** The old routes' query number. */
function whole(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null) return fallback;
  const parsed = /^\d{1,3}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw agentXError("CONFIG_INVALID", `${name} must be a whole number from ${min} to ${max}`);
  return parsed;
}

/** The old People effects' dependencies: a deployment with no issuer has no People confirmation. */
function effects(deps: DeveloperTaskRouteDependencies): DeveloperTaskRouteDependencies & { issuer: string } {
  if (deps.issuer === undefined || deps.issuer === "") throw agentXError("RUNTIME_UNAVAILABLE", "Task People confirmation is unavailable in this deployment");
  return { ...deps, issuer: deps.issuer };
}

/** One timeline line: fixed words around redacted text, one line, cut to the event bound. */
const line = (text: string): string => {
  // Control characters become spaces (a timeline line is one plain line).
  const flat = [...redactText(text)].map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char)).join("").replace(/\s+/gu, " ").trim();
  return flat.length <= DEVELOPER_EVENT_TEXT_MAX ? flat : `${flat.slice(0, DEVELOPER_EVENT_TEXT_MAX - 1)}…`;
};

const MOMENT_WORDS: Record<string, string> = { started: "Task started", plan_ready: "Plan ready for review", pr_opened: "Pull request opened", merged: "Pull request merged", closed: "Task closed" };
const DECISION_WORDS: Record<WorkflowSnapshot["decisions"][number]["decision"], string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", REJECT: "Rejected", SKIP: "Skipped" };
const SOURCE_WORDS: Record<string, string> = { GATE: "", SEND_BACK: " (sent back to coding)", FINDINGS: " (review findings answered)", AUTO_FIX: " (Rovara sent it back to fix)", AUTO_RETRY: " (Rovara retried a step)" };

/** One log entry as a timeline event. An approval is left out: the workflow's own decisions say it (once). */
function logEvent(entry: TaskLogEntry): DeveloperTaskEvent | undefined {
  switch (entry.kind) {
    case "status": return { at: entry.at, kind: "status", text: line(MOMENT_WORDS[entry.moment] ?? "Task updated") };
    case "plan_summary": return { at: entry.at, kind: "progress", text: line(`Plan summary (${entry.risk} risk): ${entry.needed}`) };
    case "question": return { at: entry.at, kind: "message", text: line(`Question: ${entry.text}`) };
    case "answer": return { at: entry.at, kind: "message", text: line(`Answer from ${entry.by}: ${entry.text}`) };
    case "pr": return { at: entry.at, kind: "status", text: line(`Pull request: ${entry.urls.join(" ")}`) };
    case "approval": return undefined;
  }
}

/** The core task's timeline: its log and its workflow's decisions, the newest `limit`, oldest first. A log that cannot be read leaves only the decisions (never an error for a read). */
async function coreTimeline(store: Pick<DocumentStore, "query">, companyId: OrgId, task: DeveloperTaskRecord, limit: number): Promise<DeveloperTaskEvent[]> {
  const logged = await readTaskLog(store, companyId, task.taskId).catch(() => [] as TaskLogEntry[]);
  const decisions = (task.workflow?.decisions ?? []).map((decision): DeveloperTaskEvent => ({
    at: decision.at, kind: "status", text: line(`${DECISION_WORDS[decision.decision] ?? "Decided"}${SOURCE_WORDS[decision.source ?? "GATE"] ?? ""}${decision.actorRole === "AGENTX" ? "" : `: ${decision.reason}`}`),
  }));
  const events = [...logged.flatMap((entry) => logEvent(entry) ?? []), ...decisions].filter((event) => typeof event.at === "string" && Number.isFinite(Date.parse(event.at)));
  // Oldest first; the newest `limit` of them.
  events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return events.slice(-limit);
}

/** Comment targets are verified with the core's company-scoped artifact reader. */
function ruleDependencies(deps: DeveloperTaskRouteDependencies, artifacts: ArtifactReader | undefined): DeveloperTaskRouteDependencies {
  if (artifacts === undefined) return deps;
  return { ...deps, actions: { ...deps.actions, readArtifact: async (key, maxBytes) => {
    const bytes = await artifacts.get(key, maxBytes);
    if (bytes === undefined) throw Object.assign(new Error("artifact not found"), { name: "NoSuchKey" });
    return Buffer.from(bytes).toString("utf8");
  } } };
}

/**
 * The old People page rule as the read rule's seam: it admits or throws its refusal. It says `holdsOwnTask` when it admitted the task's own person by their stored id (the legacy branch: a task with no People
 * list, which re-reads their hold on the task, `requireOwnTask`), so the rule does not read that hold a second time. A People entry (a revision is on the access) is admitted with no grant read.
 */
export async function pageRule(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord): Promise<void | { holdsOwnTask: true } | { viaChannelShare: true }> {
  // A core task is read as the person the core read: NO Slack identity reaches the old page rule, so its legacy branch (a channel member read from the cached, ten-minute membership list) can never be reached for a
  // plan comments or a diff read. A channel member who reads a shared core task is the People list's implicit commenter, whose channel membership the page rule reads LIVE.
  const { slackUserId: _slack, ...core } = caller;
  void _slack;
  const access = await resolveCoreTaskAccess(deps, core, task, "read");
  if (access.viaChannelShare === true) return { viaChannelShare: true };
  if (access.peopleRevision === undefined && task.developerId === caller.developerId) return { holdsOwnTask: true };
}

/**
 * The old routes, for a core task. `depsFor` builds, for this person, exactly the dependencies the developer routes build for their task routes (`developerTaskRouteDependencies`), with the caller's company.
 */
async function documentRoute(rest: string, deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, url: URL, request: CoreTaskRuleRouteInput["request"], authorize: CoreTaskRuleRouteInput["authorize"]): Promise<BrokerResponse | undefined> {
  if (rest === "diff") {
    // The one read rule decides; the People page rule (the old gate of this read) is its one seam here, so the rule keeps one implementation.
    const decision = await authorize("diff", { peoplePage: () => pageRule(deps, caller, task) });
    return json(await readCoreTaskDiffPage(deps, decision, url));
  }
  if (rest === "comments") {
    // A read of the comments asks the one rule (the old People page rule is its seam); a POST is a comment, judged by the comment action's own rule inside `createCorePlanComment`.
    // The comment is judged by the comment action's own rule (the People list's, which gives the Slack channel share its commenter role). A person the task is shared with by the stored share ("Can view") comments too (owner
    // decision 254zzz558): asked of the one read rule only after the People rule said "no such task", and only the stored share's decision counts.
    if (request.method === "POST") return json(await createCorePlanComment(deps, caller, task, bodyOf(request), async () => (await authorize("comments", { peoplePage: () => pageRule(deps, caller, task) }).catch(() => undefined))?.mode === "shared"));
    return json(await listCorePlanComments(deps, await authorize("comments", { peoplePage: () => pageRule(deps, caller, task) })));
  }
  return undefined;
}

export function createCoreTaskRuleRoutes(depsFor: (person: { developerId: string; name: string }, companyId: OrgId) => DeveloperTaskRouteDependencies, artifacts?: ArtifactReader): CoreTaskRuleRoutes {
  const peopleOf = (input: Pick<CoreTaskRuleRouteInput, "person" | "companyId" | "task">) => {
    const task = input.task as unknown as DeveloperTaskRecord;
    if (input.task["companyId"] !== input.companyId || typeof task.taskId !== "string") throw agentXError("TASK_NOT_FOUND", "no task of yours");
    const deps: DeveloperTaskRouteDependencies = { ...ruleDependencies(depsFor(input.person, input.companyId), artifacts), companyId: input.companyId };
    const caller: DeveloperCaller = { developerId: input.person.developerId, sessionId: "core", amr: "oidc", name: input.person.name };
    return { deps, caller, taskId: task.taskId };
  };
  return {
    people: {
      async view(input) {
        const { deps, caller, taskId } = peopleOf(input);
        return await getTaskPeople(deps, caller, taskId);
      },
      async takeOwnership(input) {
        const { deps, caller, taskId } = peopleOf(input);
        // Two server steps, never one: the propose step binds the People revision the person saw and checks their right; the confirm step reads both again.
        const proposed = await proposeTaskOwnership(effects(deps), caller, taskId, { requestId: input.requestId, expectedPeopleRevision: input.expectedPeopleRevision });
        if (proposed.status === "PENDING") await confirmTaskPeopleProposal(effects(deps), caller, taskId, input.requestId);
      },
    },
    async holdsOwnTask(input) {
      const task = input.task as unknown as DeveloperTaskRecord;
      if (input.task["companyId"] !== input.companyId || typeof task.taskId !== "string") return false;
      const deps: DeveloperTaskRouteDependencies = { ...ruleDependencies(depsFor(input.person, input.companyId), artifacts), companyId: input.companyId };
      return await holdsOwnTask(deps, task, input.person.developerId);
    },
    async peoplePage(input) {
      const { deps, caller } = peopleOf(input);
      return await pageRule(deps, caller, input.task as unknown as DeveloperTaskRecord);
    },
    async sharedReader(input) {
      const task = input.task as unknown as DeveloperTaskRecord;
      if (input.task["companyId"] !== input.companyId || typeof task.taskId !== "string") return undefined;
      const deps: DeveloperTaskRouteDependencies = { ...ruleDependencies(depsFor(input.person, input.companyId), artifacts), companyId: input.companyId };
      return await readerShare(deps, task, input.person.developerId);
    },
    async route(input) {
      const served = coreTaskRuleOf(input.path, input.request.method);
      if (served === undefined) throw agentXError("NOT_FOUND", "route not found");
      const { taskId, rest } = served;
      const task = input.task as unknown as DeveloperTaskRecord;
      // The core read the task from this company; it is checked once more here, so nothing below can act on another company's task.
      if (task.taskId !== taskId || input.task["companyId"] !== input.companyId) throw agentXError("TASK_NOT_FOUND", `no task ${taskId} of yours`);
      const deps: DeveloperTaskRouteDependencies = { ...ruleDependencies(depsFor(input.person, input.companyId), artifacts), companyId: input.companyId };
      const log = (entry: Record<string, unknown>): void => { deps.log?.(entry); };
      const caller: DeveloperCaller = { developerId: input.person.developerId, sessionId: "core", amr: "oidc", name: input.person.name };
      const url = new URL(input.request.path, "https://agentx.invalid");
      if (rest === "people") return json({ view: await getTaskPeople(deps, caller, taskId) });
      if (rest === "people/candidates") return json({ candidates: await getTaskPeopleCandidates(effects(deps), caller, taskId) });
      if (rest === "people/add") return json({ change: await addTaskWebPerson(effects(deps), caller, taskId, parse(TaskPeopleAddRequestSchema, bodyOf(input.request), log, "people/add")) });
      if (rest === "people/role") return json({ change: await proposeTaskPeopleRole(effects(deps), caller, taskId, parse(TaskPeopleRoleRequestSchema, bodyOf(input.request), log, "people/role")) });
      if (rest === "people/take-ownership") return json({ change: await proposeTaskOwnership(effects(deps), caller, taskId, parse(TaskPeopleTakeOwnershipRequestSchema, bodyOf(input.request), log, "people/take-ownership")) });
      if (rest.startsWith("people/requests/")) return json({ change: await getTaskPeopleProposal(effects(deps), caller, taskId, safeDecode(rest.slice("people/requests/".length))) });
      const document = await documentRoute(rest, deps, caller, task, url, input.request, (read, seams) => input.authorize(read, seams));
      if (document !== undefined) return document;
      // Readers and the timeline: the one read rule says who may (the task's own person, or a reader it is shared with who is still a project member; anyone else reads no such task, in the old owner check's words).
      const decision = await input.authorize(rest === "events" ? "events" : "share");
      if (rest === "events") return json({ events: await coreTimeline(input.store, input.companyId, task, whole(url.searchParams.get("limit"), DEVELOPER_EVENTS_DEFAULT, 1, DEVELOPER_EVENTS_MAX, "limit")) });
      if (decision.mode !== "owner") throw agentXError("FORBIDDEN", "only the task's owner can share it");
      if (rest === "readers") return json(await listTaskReaders(deps, task));
      const developerId = safeDecode(rest.slice("readers/".length));
      if (input.request.method === "PUT") return json(await grantTaskReader(deps, task, caller.developerId, developerId, bodyOf(input.request)));
      return json(await revokeTaskReader(deps, task, caller.developerId, developerId));
    },
  };
}
