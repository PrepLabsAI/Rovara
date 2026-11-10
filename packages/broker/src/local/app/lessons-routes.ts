// The owner's routes for lessons, on the paths a hosted install serves them on, so the command line and the editor tools speak to either with one client:
// GET /v1/app/projects/{p}/lessons what Rovara has learned for the project: what waits for a decision, what is used, what was removed
// GET /v1/app/projects/{p}/lessons/{id}/history one lesson's versions and who approved each
// POST /v1/app/projects/{p}/lessons/{id}/approve|reject|merge|retire refused: a lesson is decided on its page, in the owner's browser (`rovara open lessons`), because each of these is the owner's own act
// GET /v1/app/projects/{p}/lessons/repo the project's repositories with the state of their `.rovara/lessons.md`
// POST /v1/app/projects/{p}/lessons/repo refused: the switches for the file are on the page too
// GET /v1/app/tasks/{task}/lessons the lessons a task was given
// POST /v1/app/tasks/{task}/lessons/{id}/feedback refused: marking a lesson wrong is done on the page or by a writer's comment on the pull request
// The API token only reads. Authentication happens before this (the identity adapter vouches for the principal). Nothing here reads who is acting from a body.
import { agentXError } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { readTask } from "../../core/task-flow/reads.js";
import { repoFileStatus } from "../../lessons/repo-file-routes.js";
import { buildLessonHistory, buildLessonsView, buildLoadedLessons } from "../../lessons/view.js";
import type { LocalLessons } from "./lessons.js";

const PROJECT_LESSONS = /^\/v1\/app\/projects\/([^/]+)\/lessons(?:\/([A-Za-z0-9_-]{1,64})(?:\/(approve|reject|merge|retire|history))?)?$/u;
const TASK_LESSONS = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/lessons(?:\/([A-Za-z0-9_-]{4,64})\/feedback)?$/u;
export const DECIDE_ON_THE_PAGE = "A lesson is approved on its page, by you. Run `rovara open lessons` to open it; an assistant cannot approve for you.";
export const CHANGE_ON_THE_PAGE = "This is changed on the lessons page, by you. Run `rovara open lessons` to open it; the API token can only read.";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

export function createLessonRoutes(options: { lessons: LocalLessons; flow: TaskFlowDeps }): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { lessons, flow } = options;
  const companyId = flow.companyId;
  const runtime = lessons.runtime;
  return async (request, caller) => {
    const path = request.path.split("?")[0] ?? request.path;
    const project = PROJECT_LESSONS.exec(path);
    const task = TASK_LESSONS.exec(path);
    if (project === null && task === null) return undefined;
    try {
      if (caller.principal.companyId !== companyId) throw agentXError("FORBIDDEN", "this is not your install");
      const who = { orgId: companyId, developerId: caller.principal.personId };
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
