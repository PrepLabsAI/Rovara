// Lead 4 A1 + A2: the cost and time report's routes on the deployed developer API, for Cloud's admin portal, AS the signed-in person (the contract file, cost-report.ts, lists them with their bodies):
//
//   GET  /v1/app/org/report/tasks                  one row per task that started in the range                          company owner or admin
//   GET  /v1/app/org/report/features               the company's features                                              company owner or admin
//   POST /v1/app/org/report/features               make a feature                                                      company owner or admin
//   POST /v1/app/org/report/features/{id}/rename   rename it                                                           company owner or admin
//   POST /v1/app/org/report/features/{id}/merge    merge it into another feature                                       company owner or admin
//   POST /v1/app/org/report/features/{id}/state    mark it open or done                                                company owner or admin
//   POST /v1/app/tasks/{taskId}/feature            file a task under a feature, or move it (null: No feature)          the task's starter files it; a maintainer, owner or admin moves it
//
// Rules:
//  - The company is the caller's LIVE membership (the dev routes check it and mount that company's runtime), never a header, query, body or token claim; the role is membership's live role, not a claim.
//    Every key is built from that company, and every row read is checked against it again (`rowBelongsToCompany`). No route reads across companies.
//  - Reading the report and changing features: a live company owner or admin. A member, anyone else and a script token (refused before this file) never reach them. The forbidden answer names nothing.
//  - Moving a task: the task is read in the caller's company first; a task of another company, a missing one, and one the caller may neither drive (the task's starter) nor manage (owner, admin, or the
//    project's administrator, read live) all answer the same 404. A starter who is not a maintainer files a task that has no feature once; moving it afterwards (or filing a task that already has one) is a maintainer's.
//  - Every change writes its audit record in the same transaction (who and when are there; the rows name nobody). Refusals are fixed words: nothing a caller sent is echoed.
import {
  AgentXError, CreateFeatureBodySchema, FEATURE_ADMIN_ONLY, FeatureStateBodySchema, MergeFeatureBodySchema, OrgRoleSchema, REPORT_ADMIN_ONLY, REPORT_UNAVAILABLE, RenameFeatureBodySchema,
  TASK_FEATURE_NEEDS_MAINTAINER, TASK_FEATURE_NOT_FOUND, TASK_FEATURE_PATH_PATTERN, TaskFeatureBodySchema, agentXError,
  type AuditSink, type OrgId, type OrgRole, type FeatureResponse, type FeaturesResponse, type TaskFeatureResponse,
} from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { readTask } from "../core/task-flow/reads.js";
import { createFeatureStore, featureView, type FeatureActor, type FeatureRecord } from "../core/report/feature-store.js";
import { readCompanyReportTasks } from "../core/report/read.js";
import type { SetupRunStanding } from "./setup-run-routes.js";

export interface HostedReportWiring {
  /** The person's standing on a project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the move then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
}

export interface HostedReportInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  principal: TaskStartCaller["principal"];
  /** The caller's live role in the member company (membership, never a claim). */
  role: OrgRole;
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedReportWiring;
  /** The audit sink of this request (it names the caller it came through). */
  audit: Pick<AuditSink, "stage">;
  now: () => number;
}

const REPORT_READ = /^\/v1\/app\/org\/report\/(tasks|features)$/u;
const FEATURE_ACTION = /^\/v1\/app\/org\/report\/features\/([^/]+)\/(rename|merge|state)$/u;
const QUERY_KEYS = new Set(["from", "to", "project", "origin", "state", "path", "limit", "cursor"]);
const LIMIT = /^[1-9][0-9]{0,3}$/u;
const BODY_REFUSED = "The request is not valid.";

/** Whether this method and path is one of the report's. */
export function isReportPath(path: string, method: string): boolean {
  if (REPORT_READ.test(path)) return path.endsWith("/tasks") ? method === "GET" : method === "GET" || method === "POST";
  return method === "POST" && (FEATURE_ACTION.test(path) || TASK_FEATURE_PATH_PATTERN.test(path));
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", REPORT_UNAVAILABLE);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", BODY_REFUSED); }
}
function parsed<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw agentXError("CONFIG_INVALID", BODY_REFUSED);
  return result.data;
}
/** The query string as a plain object: each parameter once, non-empty, named in `QUERY_KEYS`. The reader's own schema checks every value. */
function queryOf(path: string, raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of new URL(raw.includes("?") ? raw : `${path}`, "http://core").searchParams) {
    if (!QUERY_KEYS.has(name) || name in out || value === "") throw agentXError("CONFIG_INVALID", "the report query is not valid");
    out[name] = name === "limit" ? (LIMIT.test(value) ? Number(value) : value) : value;
  }
  return out;
}

const viewOf = (record: FeatureRecord) => {
  const view = featureView(record);
  if (view === undefined) throw unavailable();
  return view;
};

/** One request on a report path (`isReportPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedReport(input: HostedReportInput): Promise<BrokerResponse> {
  try {
    const role = OrgRoleSchema.safeParse(input.role);
    const admin = role.success && (role.data === "owner" || role.data === "admin");
    const features = createFeatureStore({ store: input.flow.store, companyId: input.companyId, audit: input.audit, now: input.now });
    const actor: FeatureActor = { type: "person", id: input.principal.personId };

    const read = REPORT_READ.exec(input.path);
    if (read !== null && input.request.method === "GET") {
      if (!admin) throw agentXError("FORBIDDEN", REPORT_ADMIN_ONLY);
      if (read[1] === "tasks") return json(200, await readCompanyReportTasks(input.flow.store, input.companyId, queryOf(input.path, input.request.path), input.now()));
      const body: FeaturesResponse = { features: (await features.list()).map(viewOf) };
      return json(200, body);
    }
    if (read !== null && read[1] === "features" && input.request.method === "POST") {
      if (!admin) throw agentXError("FORBIDDEN", FEATURE_ADMIN_ONLY);
      const made = parsed(CreateFeatureBodySchema, bodyOf(input.request));
      const body: FeatureResponse = { feature: viewOf(await features.create(made, actor)) };
      return json(201, body);
    }

    const action = FEATURE_ACTION.exec(input.path);
    if (action !== null) {
      if (!admin) throw agentXError("FORBIDDEN", FEATURE_ADMIN_ONLY);
      const id = action[1]!;
      const body = bodyOf(input.request);
      const record = action[2] === "rename" ? await features.rename(id, parsed(RenameFeatureBodySchema, body).name, actor)
        : action[2] === "state" ? await features.setState(id, parsed(FeatureStateBodySchema, body).state, actor)
          : await features.merge(id, parsed(MergeFeatureBodySchema, body).into, actor);
      // A merged feature is not listed: the answer is the one it was merged into.
      if (action[2] === "merge") {
        const target = await features.get(parsed(MergeFeatureBodySchema, body).into);
        if (target === undefined) throw unavailable();
        return json(200, { feature: viewOf(target) } satisfies FeatureResponse);
      }
      return json(200, { feature: viewOf(record) } satisfies FeatureResponse);
    }

    const move = TASK_FEATURE_PATH_PATTERN.exec(input.path);
    if (move !== null) {
      const taskId = move[1]!;
      const { feature } = parsed(TaskFeatureBodySchema, bodyOf(input.request));
      // The task is read first, in the caller's company: another company's task and a missing one answer alike, whatever the body said.
      const task = await readTask(input.flow, taskId).catch(() => { throw unavailable(); });
      // A setup run and a replay are not feature work (the report never lists them): they read as missing tasks here too.
      if (task === undefined || task.companyId !== input.companyId || input.principal.companyId !== input.companyId || task.purpose !== undefined || task.origin === "test_run") throw agentXError("NOT_FOUND", TASK_FEATURE_NOT_FOUND);
      // A live company owner or admin (membership's role) manages every project; anyone else manages the project only by their live standing on it.
      let manager = admin;
      if (!manager) {
        try { manager = (await input.wiring.standing(input.principal.personId, input.companyId, task.project))?.access === "manage"; } catch { throw unavailable(); }
      }
      let starter = false;
      try { starter = await input.flow.access.canAct(input.principal, task); } catch { throw unavailable(); }
      if (!manager && !starter) throw agentXError("NOT_FOUND", TASK_FEATURE_NOT_FOUND);
      const existing = await features.taskFeature(taskId);
      // A starter/plan approver may replace a suggestion, including one confirmed at plan approval.
      // A deliberate filing is moved by a manager; their `moved` source remains the highest rule.
      if (!manager && existing !== undefined && existing.source !== "tracker" && existing.source !== "confirmed_at_plan") throw agentXError("FORBIDDEN", TASK_FEATURE_NEEDS_MAINTAINER);
      const source = manager ? "moved" as const : "chosen" as const;
      const set = await features.setTaskFeature({ taskId, project: task.project, featureId: feature, source }, actor);
      const filed = set.record.featureId === null ? null : { id: set.record.featureId, source: set.record.source };
      return json(200, { task: { taskId, feature: filed } } satisfies TaskFeatureResponse);
    }
    throw agentXError("NOT_FOUND", "route not found");
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    // A store fault is a fixed 503 that names nothing.
    return errorAnswer(unavailable());
  }
}
