// The owner's routes for lessons, on the paths a hosted install serves them on, so the command line and the editor tools speak to either with one client:
// GET /v1/app/projects/{p}/lessons what Rovara has learned for the project: what waits for a decision, what is used, what was removed
// GET /v1/app/projects/{p}/lessons/{id}/history one lesson's versions and who approved each
// POST /v1/app/projects/{p}/lessons/{id}/approve|reject|merge|retire refused: a lesson is decided on its page, in the owner's browser (`rovara open lessons`), because each of these is the owner's own act
// GET /v1/app/projects/{p}/lessons/repo the project's repositories with the state of their `.rovara/lessons.md`
// POST /v1/app/projects/{p}/lessons/repo refused: the switches for the file are on the page too
// GET /v1/app/tasks/{task}/lessons the lessons a task was given
// POST /v1/app/tasks/{task}/lessons/{id}/feedback refused: marking a lesson wrong is done on the page or by a writer's comment on the pull request
// GET /v1/app/projects/{p}/lessons/local-tools whether local coding tools get the project's lessons now, and why not (decision 46b)
// POST /v1/app/projects/{p}/lessons/local-tools refused: the switch is on the lessons page
// GET /v1/app/org/lessons/local-tools the install's "lessons stay in Rovara" switch
// POST /v1/app/org/lessons/local-tools refused: the switch is on the lessons page
// POST /v1/dev/projects/{p}/lessons a local coding tool's read (decision 46b): the lessons the whole project may read, stable or person-approved, for the repository its git remote names. The owner's API token or a
// script token with the `lessons` permission for that project; 60 a minute per person; the day's count per person and project holds numbers only (no lesson, task, file or repository text).
// The API token only reads. Authentication happens before this (the identity adapter vouches for the principal). Nothing here reads who is acting from a body.
import { INDEX_EXPIRY_ATTRIBUTE, LocalLessonsBodySchema, agentXError, change, companyScoped, indexExpiresAt, type DocumentStore } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { readTask } from "../../core/task-flow/reads.js";
import { repoFileStatus } from "../../lessons/repo-file-routes.js";
import { buildLessonHistory, buildLessonsView, buildLoadedLessons } from "../../lessons/view.js";
import { takeRate } from "../../core/script-tokens/rate.js";
import { LocalLessonsUnavailable, lessonsForLocalTool, type LocalLessonsDeps, type LocalToolsCounter } from "../../lessons/local-tools.js";
import { readLocalToolsState } from "../../lessons/local-tools-setting.js";
import { peopleOf, type Lesson } from "../../lessons/types.js";
import type { ScopeKey } from "../../lessons/store.js";
import type { LocalLessons } from "./lessons.js";

const PROJECT_LESSONS = /^\/v1\/app\/projects\/([^/]+)\/lessons(?:\/([A-Za-z0-9_-]{1,64})(?:\/(approve|reject|merge|retire|history))?)?$/u;
const TASK_LESSONS = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/lessons(?:\/([A-Za-z0-9_-]{4,64})\/feedback)?$/u;
const LOCAL_LESSONS = /^\/v1\/dev\/projects\/([^/]+)\/lessons$/u;
const COMPANY_LOCAL_TOOLS = "/v1/app/org/lessons/local-tools";
export const LOCAL_LESSONS_PER_MINUTE = 60;
const UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
const NO_SUCH_PROJECT = "No such project.";
/** At most this many people's names are looked up in one call (the repo-file pass's limit): over it, nothing is returned. */
const MAX_NAME_LOOKUPS = 300;

/** The day's counter row: fixed numbers per person, project and day, expired by the store's index retention. Best effort: a failure to count never blocks or changes the answer. */
export function localLessonsDayCounter(store: DocumentStore, now: () => number): LocalToolsCounter {
  return {
    async count(event) {
      const day = new Date(now()).toISOString().slice(0, 10);
      const refused = event.refusal === undefined ? undefined : `refused_${event.refusal.replace(/[^a-z_]/gu, "").slice(0, 40)}`;
      await store.update({
        key: { pk: companyScoped(event.orgId, "LESSON_LOCAL_DAY"), sk: `${event.project}#${event.developerId}#${day}` },
        ops: [
          change.set("entityType", "LESSON_LOCAL_DAY"), change.set("day", day), change.set(INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt(new Date(now()).toISOString())),
          change.add("calls", 1), change.add("lessonsReturned", event.lessons), ...(refused === undefined ? [] : [change.add(refused, 1)]),
        ],
      });
    },
  };
}
export const DECIDE_ON_THE_PAGE = "A lesson is approved on its page, by you. Run `rovara open lessons` to open it; an assistant cannot approve for you.";
export const CHANGE_ON_THE_PAGE = "This is changed on the lessons page, by you. Run `rovara open lessons` to open it; the API token can only read.";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

export function createLessonRoutes(options: { lessons: LocalLessons; flow: TaskFlowDeps }): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { lessons, flow } = options;
  const companyId = flow.companyId;
  const runtime = lessons.runtime;
  const nowMs = (): number => (flow.now?.() ?? new Date()).getTime();
  const counter = localLessonsDayCounter(flow.store, nowMs);

  /** The display names a lesson that leaves Rovara must not hold: the owner's, the person asking, and the people of the lessons asked about; a name that cannot be read, or too many people, throws. */
  async function peopleNames(developerId: string, key: ScopeKey, found: readonly Lesson[]): Promise<string[]> {
    const ids = new Set<string>([lessons.owner.id, developerId]);
    for (const lesson of found) for (const id of peopleOf(lesson)) ids.add(id);
    if (ids.size > MAX_NAME_LOOKUPS) throw new Error("too many people to look up");
    const names: string[] = [lessons.owner.name];
    for (const id of ids) {
      const name = await runtime.routes.names.memberName(key.workspaceId, id);
      if (name !== undefined) names.push(name);
    }
    return names;
  }

  /** A local coding tool's read (decision 46b). The token's permission and project were checked when it was authenticated; they are checked again here. */
  async function localRead(project: string, request: BrokerRequest, caller: TaskCaller): Promise<object> {
    const developerId = caller.principal.personId;
    let allowed: boolean;
    try { allowed = await takeRate(flow.store, { pk: companyScoped(companyId, "LESSON_LOCAL_READS"), sk: developerId }, LOCAL_LESSONS_PER_MINUTE, 60_000, nowMs); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many lesson requests. Try again in a minute.");
    if (caller.scriptToken !== undefined && (!caller.scriptToken.permissions.includes("lessons") || !caller.scriptToken.projects.includes(project))) throw agentXError("NOT_FOUND", NO_SUCH_PROJECT);
    if (await flow.projects.latest(project) === undefined) throw agentXError("NOT_FOUND", NO_SUCH_PROJECT);
    let raw: unknown;
    try { raw = request.body === undefined || request.body === "" ? {} : JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "body: is not JSON"); }
    const parsed = LocalLessonsBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // Field names only: the values are the caller's.
      throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
    }
    const count = async (found: number, refusal?: string): Promise<void> => { try { await counter.count({ orgId: companyId, project, developerId, lessons: found, refusal }); } catch { /* bookkeeping only */ } };
    const deps: LocalLessonsDeps = {
      store: runtime.store, settings: runtime.settings, access: runtime.access, localTools: runtime.localTools, now: nowMs,
      names: (key, found) => peopleNames(developerId, key, found),
      log: (event, fields) => flow.log?.({ component: "lessons", event, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === "number" || typeof value === "boolean")) }),
      // What is merged into the repository's own lessons file now (decision 50a): the file pass's state, ids only.
      ...(runtime.repoFile === undefined ? {} : { repoFileIds: async (key: ScopeKey, place: string) => { const state = await runtime.repoFile!.deps.state.get(key, place); return state === undefined ? undefined : new Set(Object.keys(state.rendered)); } }),
    };
    let outcome: Awaited<ReturnType<typeof lessonsForLocalTool>>;
    try {
      outcome = await lessonsForLocalTool(deps, { orgId: companyId, project, remote: parsed.data.repo, task: parsed.data.task, files: parsed.data.files, stage: parsed.data.stage, all: parsed.data.all, skipRepoFile: parsed.data.skipRepoFile });
    } catch (error) {
      await count(0, error instanceof LocalLessonsUnavailable ? "unavailable" : "error");
      throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
    }
    if (outcome.kind === "unknown_repo") {
      await count(0, "unknown_repo");
      throw agentXError("NOT_FOUND", NO_SUCH_PROJECT);
    }
    await count(outcome.answer.lessons.length, outcome.answer.reason);
    return outcome.answer;
  }

  return async (request, caller) => {
    const path = request.path.split("?")[0] ?? request.path;
    const project = PROJECT_LESSONS.exec(path);
    const task = TASK_LESSONS.exec(path);
    const local = request.method === "POST" ? LOCAL_LESSONS.exec(path) : null;
    if (project === null && task === null && local === null && path !== COMPANY_LOCAL_TOOLS) return undefined;
    try {
      if (caller.principal.companyId !== companyId) throw agentXError("FORBIDDEN", "this is not your install");
      const who = { orgId: companyId, developerId: caller.principal.personId };
      if (local !== null) return json(200, await localRead(decodeURIComponent(local[1]!), request, caller));
      if (path === COMPANY_LOCAL_TOOLS) {
        if (request.method === "POST") throw agentXError("FORBIDDEN", CHANGE_ON_THE_PAGE);
        if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
        try { return json(200, { stays: await runtime.localTools.readCompany(companyId) }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
      }
      if (project !== null) {
        const name = decodeURIComponent(project[1]!);
        const known = await flow.projects.latest(name);
        if (known === undefined) throw agentXError("NOT_FOUND", "No such project.");
        const id = project[2];
        const action = project[3];
        if (id === undefined) {
          if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
          return json(200, await buildLessonsView(runtime.routes, who, name));
        }
        if (id === "repo" && action === undefined) {
          if (runtime.repoFile === undefined) throw agentXError("NOT_FOUND", "Lessons are not available for this project.");
          if (request.method === "GET") {
            try { return json(200, await repoFileStatus(runtime.repoFile, { workspaceId: companyId, project: name })); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "Rovara can't read this project's repositories right now. Try again."); }
          }
          if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
          throw agentXError("FORBIDDEN", CHANGE_ON_THE_PAGE);
        }
        if (id === "local-tools" && action === undefined) {
          if (request.method === "POST") throw agentXError("FORBIDDEN", CHANGE_ON_THE_PAGE);
          if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
          try { return json(200, await readLocalToolsState({ localTools: runtime.localTools, settings: runtime.settings }, companyId, name)); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
        }
        if (action === "history" && request.method === "GET") return json(200, await buildLessonHistory(runtime.routes, who, name, id));
        if (request.method !== "POST" || action === undefined) throw agentXError("NOT_FOUND", "route not found");
        if (action === "approve" || action === "reject" || action === "merge") throw agentXError("FORBIDDEN", DECIDE_ON_THE_PAGE);
        if (action === "retire") throw agentXError("FORBIDDEN", CHANGE_ON_THE_PAGE);
        throw agentXError("NOT_FOUND", "route not found");
      }
      const record = await readTask(flow, task![1]!);
      if (record === undefined || record.companyId !== companyId || !(await flow.access.canAct(caller.principal, record))) throw agentXError("TASK_NOT_FOUND", "no such task");
      const lessonId = task![2];
      if (lessonId === undefined) {
        if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
        return json(200, await buildLoadedLessons(runtime.routes, who, record.project, record.taskId));
      }
      if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
      throw agentXError("FORBIDDEN", CHANGE_ON_THE_PAGE);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && "code" in error) {
        const known = error as Error & { statusCode: number; code: string };
        return json(known.statusCode, { error: { code: known.code, message: known.message.slice(known.code.length + 2) } });
      }
      flow.log?.({ component: "lessons", event: "route_failed", error: error instanceof Error ? error.name : "unknown" });
      return json(500, { error: { code: "INTERNAL", message: "that could not be answered" } });
    }
  };
}
