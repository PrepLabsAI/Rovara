// Guided onboarding L2-3 (DEC 254o c, DEC 254n 3): the hosted setup run. The core setup agent (core/setup-agent/*), which the laptop serves to its install owner only
// (local/app/setup-agent.ts), served on the deployed developer API for a company on the core engine, AS the signed-in person:
//
//   GET  /v1/app/projects/{project}/setup-agent            where the project's setup run stands (the core's SetupAgentView) plus `canManage`
//   POST /v1/app/projects/{project}/setup-agent            start a run, or RE-RUN one that ended ({ requestId }); 202 started, 200 a repeat of the same request id
//   POST /v1/app/projects/{project}/setup-agent/stop       stop the running run ({ requestId })
//   GET  /v1/app/projects/{project}/setup-agent/journal    the run's journal (`?after=<n>`) and the websites it asked for
//   POST /v1/app/projects/{project}/setup-agent/confirm    "Use this setup": the run's verified commands become a CANDIDATE revision checked on a fresh workspace (apply.ts); nothing is applied
//   POST /v1/app/projects/{project}/setup-agent/discard    drop a waiting candidate ({}); applies nothing
//
// Rules:
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, a query, a body or a token claim; every key is the company's own (the runtime's).
//   - Who (DEC 254n 3, the rule of PR 16's `lifecycleAccess`): a live owner or admin of the company, or an administrator of the project, MANAGES (starts, re-runs, stops, confirms,
//     discards); a person who uses the project (a developer grant) READS the run and its journal; anyone else, another company's project, a missing one and a malformed name all answer
//     the same 404 "project not found". The standing is read live on every request, again inside the start (the start's own access check), and before every step the run takes
//     (`hostedTaskAccess.checkStep` for a setup run). A change by a reader is 403 in fixed words.
//   - One run per project: the core's conditional pointer write (`setupAgentPointerItem`) in the start's own transaction. A re-run of a working project only PROPOSES: the project's
//     commands change only after confirm, a passing check on a fresh workspace and an approval (apply.ts); a failed or stopped re-run never replaces a working setup.
//   - Every start, re-run, stop, confirm and discard leaves an audit record naming the person and why they were allowed (the runtime's audit sink): a start's in the start's own
//     transaction; the others' before the act, so nothing is done when the record cannot be written.
//   - A start needs the company on the core for NEW tasks and the install's model gateway (which meters the run); otherwise a fixed 503 and nothing is written.
//   - Bodies are the core's strict schemas (a request id and nothing else for start and stop: limits, payer and goal never come from the client).
import { AgentXError, agentXError, type AuditEvent, type AuditSink, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { startTask } from "../core/task-flow/start.js";
import { cancelTask } from "../core/task-flow/cancel.js";
import { SetupAgentStartBodySchema, SetupAgentStopBodySchema, getSetupAgent, readState, startSetupAgent, stopSetupAgent, type SetupAgentDeps } from "../core/setup-agent/agent.js";
import { SetupConfirmBodySchema, confirmSetupAgent, discardSetupApply, type SetupApplyDeps } from "../core/setup-agent/apply.js";
import { readSetupJournal } from "../core/setup-agent/journal.js";
import { listHostAsks } from "../core/setup-agent/host-ask.js";
import { setupAgentKey } from "../core/setup-agent/keys.js";
import { ensureCoreInUse } from "./engine-stamp.js";

export const SETUP_RUN_PROJECT_NOT_FOUND = "project not found";
export const SETUP_RUN_NOT_ALLOWED = "Only company owners and admins, or this project's admins, can run the project's setup.";
export const SETUP_RUN_UNAVAILABLE = "Setting a project up with Rovara isn't available for this company yet.";
export const SETUP_RUN_UNREADABLE = "The project's setup could not be read just now. Try again.";
export const SETUP_RUN_AUDIT_UNAVAILABLE = "The record of this change could not be written, so nothing was done. Try again.";

/** Why a person may manage a project's setup run, as the audit record names it. */
export type SetupRunBasis = "company-owner" | "company-admin" | "project-admin";
/** A person's standing on one project of their company, read live: `manage` (with its basis), `view`, or `none`. */
export type SetupRunStanding = { access: "manage"; basis: SetupRunBasis } | { access: "view" | "none" };

/** What the deployment wires for the hosted setup run (aws/core-engine-root.ts). */
export interface HostedSetupRunWiring {
  /**
   * The person's standing on the project in THIS company, read live (membership and the project grant; PR 16's `lifecycleAccess`). A person who is not a live member of the company
   * is `none`. Throws when it cannot be read (the route then refuses in fixed words; a start refuses).
   */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** Whether the install's model gateway is configured (it meters and prices a run). False: a start is refused. */
  modelAccessConfigured(): boolean;
  /** The code host's file read at a commit, for re-reading a proposal's citations. Absent: every item is `unchecked` (and confirm refuses). */
  readFile?: SetupAgentDeps["readFile"];
  /** A person's display name, for "stopped by". Absent or unknown: "Unknown". */
  displayName?: ((personId: string) => Promise<string | undefined>) | undefined;
}

export interface HostedSetupRunInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  principal: TaskStartCaller["principal"];
  client?: string | undefined;
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedSetupRunWiring;
  /** The audit sink for this request (the dev routes' `auditFor`, else the runtime's). */
  audit: AuditSink;
  /** Whether the switch sends this company's NEW tasks to the core. False: a start is refused. */
  startsNewTasks: boolean;
  now: () => number;
}

const SETUP_PATH = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|journal|confirm|discard))?$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const DiscardBodySchema = z.object({}).strict();

/** Whether this method and path is the hosted setup run's. */
export function isSetupRunPath(path: string, method: string): boolean {
  const match = SETUP_PATH.exec(path);
  if (match === null) return false;
  const tail = match[2];
  if (method === "GET") return tail === undefined || tail === "journal";
  if (method === "POST") return tail === undefined || tail === "stop" || tail === "confirm" || tail === "discard";
  return false;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", SETUP_RUN_PROJECT_NOT_FOUND);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

/** A strict body or the fixed refusal (field names only, never the values). */
function parsed<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
}

async function standingOf(input: HostedSetupRunInput, project: string): Promise<SetupRunStanding> {
  let standing: SetupRunStanding;
  try { standing = await input.wiring.standing(input.principal.personId, input.companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_UNREADABLE); }
  // Anything but the three answers is no answer: read as none (never as manage).
  if (standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin")) return standing;
  if (standing?.access === "view") return { access: "view" };
  return { access: "none" };
}

/** The audit record of one act, naming the person and why they were allowed. */
function auditEvent(input: HostedSetupRunInput, action: string, eventId: string, project: string, basis: SetupRunBasis, details: Record<string, string | boolean>): AuditEvent {
  return {
    eventId, companyId: input.companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: input.principal.personId }, action,
    subject: { type: "project", id: project }, details: { project, basis, ...details },
  };
}

async function recorded(input: HostedSetupRunInput, event: AuditEvent): Promise<void> {
  try { await input.audit.record(event); } catch { throw agentXError("AUDIT_UNAVAILABLE", SETUP_RUN_AUDIT_UNAVAILABLE); }
}

/** One request on a hosted setup-run path (`isSetupRunPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedSetupRun(input: HostedSetupRunInput): Promise<BrokerResponse> {
  try {
    const match = SETUP_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!PROJECT_NAME.test(project)) throw notFound();
    const tail = match[2];
    const standing = await standingOf(input, project);
    if (standing.access === "none") throw notFound();
    const { flow, companyId } = input;
    // The project is read in the caller's company only: another company's project of the same name is never this one.
    const latest = await flow.projects.latest(project);
    if (latest === undefined) throw notFound();

    const personId = input.principal.personId;
    const deps: SetupApplyDeps = {
      store: flow.store, companyId, now: input.now, flow, modelAccessConfigured: input.wiring.modelAccessConfigured(),
      readFile: input.wiring.readFile,
      stopperName: async (by) => input.wiring.displayName?.(by),
      async latest(name) {
        const found = await flow.projects.latest(name);
        return found === undefined ? undefined : { revision: found.definition.revision, definition: found.definition };
      },
      async requireNewWork(name) {
        const found = await flow.projects.latest(name);
        if (found?.archived === true) throw agentXError("PROJECT_ARCHIVED", "This project is archived. Restore it to start new work.");
      },
      starter: {
        async start(request) {
          // The core's start, with the setup run's own access rule (DEC 254n 3) in place of the task rule, read live again inside the start; and the audit record in its transaction.
          const rerun = (await flow.store.get(setupAgentKey(companyId, request.project))) !== undefined;
          await ensureCoreInUse(flow.store, companyId);
          const setupDeps: TaskFlowDeps = {
            ...flow,
            access: {
              ...flow.access,
              async checkStart(principal, name) {
                if (principal.companyId !== companyId) return { allowed: false, code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED };
                let now: SetupRunStanding;
                try { now = await input.wiring.standing(principal.personId, companyId, name); } catch { return { allowed: false, code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNREADABLE }; }
                return now?.access === "manage" ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED };
              },
            },
            startExtras: (extras) => {
              const own = flow.startExtras?.(extras);
              const event = auditEvent(input, rerun ? "setup_run.rerun_started" : "setup_run.started", `setup_run.started:${extras.taskId}`, request.project, (standing as { basis: SetupRunBasis }).basis, { requestId: request.requestId, taskId: extras.taskId });
              return { ...(own ?? {}), items: [...(own?.items ?? []), ...input.audit.stage(event)] };
            },
          };
          const caller: TaskStartCaller = { principal: input.principal, client: input.client ?? "app", origin: "app" };
          const started = await startTask(setupDeps, caller, { requestId: request.requestId, project: request.project, instructions: request.text, title: `Set up ${request.project}` }, { setupAgent: { limits: request.limits, seenTaskId: request.seenTaskId } });
          return { taskId: started.task.taskId, duplicate: started.duplicate };
        },
        async cancel(request) { await cancelTask(flow, request.taskId); },
      },
    };

    if (input.request.method === "GET" && tail === undefined) return json(200, { ...(await getSetupAgent(deps, project)), canManage: standing.access === "manage" });
    if (input.request.method === "GET" && tail === "journal") {
      const after = Number(new URL(input.request.path, "http://core").searchParams.get("after") ?? "0");
      if (!Number.isInteger(after) || after < 0 || after > 400) throw agentXError("CONFIG_INVALID", "after: a journal position");
      const state = await readState(deps, project, latest.definition.revision);
      const asks = (await listHostAsks({ store: flow.store, now: input.now }, companyId, project, ["open", "approved", "refused"])).slice(0, 50)
        .map((ask) => ({ host: ask.host, status: ask.state, ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }), ...(ask.from === undefined ? {} : { from: ask.from }) }));
      if (state.pointer === undefined) return json(200, { status: state.view.status, entries: [], hostAsks: asks });
      return json(200, { status: state.view.status, entries: await readSetupJournal({ store: flow.store }, { orgId: companyId, project, taskId: state.pointer.taskId }, after), hostAsks: asks });
    }
    if (input.request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    // Every change: only a person who manages the project's setup.
    if (standing.access !== "manage") throw agentXError("FORBIDDEN", SETUP_RUN_NOT_ALLOWED);
    const basis = standing.basis;
    const raw = bodyOf(input.request);
    if (tail === undefined) {
      const body = parsed(SetupAgentStartBodySchema, raw);
      // A run spends model money by the minute: only where this company's new tasks run on the core, and the install's model gateway meters the run. Nothing is written otherwise.
      if (!input.startsNewTasks || !deps.modelAccessConfigured) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_UNAVAILABLE);
      const answer = await startSetupAgent(deps, project, body);
      return json(answer.status, { ...answer.view, canManage: true });
    }
    if (tail === "stop") {
      const body = parsed(SetupAgentStopBodySchema, raw);
      await recorded(input, auditEvent(input, "setup_run.stop_requested", `setup_run.stop:${companyId}:${project}:${body.requestId}`, project, basis, { requestId: body.requestId }));
      const answer = await stopSetupAgent(deps, project, body, personId);
      return json(answer.status, { ...answer.view, canManage: true });
    }
    if (tail === "confirm") {
      const body = parsed(SetupConfirmBodySchema, raw);
      await recorded(input, auditEvent(input, "setup_run.confirm_requested", `setup_run.confirm:${companyId}:${project}:${body.requestId}`, project, basis, { requestId: body.requestId }));
      return json(200, await confirmSetupAgent(deps, project, body, personId));
    }
    parsed(DiscardBodySchema, raw);
    await recorded(input, auditEvent(input, "setup_run.discard_requested", `setup_run.discard:${companyId}:${project}:${String(input.now())}`, project, basis, {}));
    return json(200, { discarded: await discardSetupApply(deps, project, personId) });
  } catch (error) {
    if (error instanceof AgentXError) {
      // The core names a missing project with its name; here every missing or unseen project reads the same.
      if (error.code === "PROJECT_NOT_FOUND") return errorAnswer(notFound());
      return errorAnswer(error);
    }
    throw error;
  }
}
