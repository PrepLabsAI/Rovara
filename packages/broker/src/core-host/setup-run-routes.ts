// Guided onboarding L2-3 (DEC 254o c, DEC 254n 3): the hosted setup run. The core setup agent (core/setup-agent/*), which the laptop serves to its install owner only
// (local/app/setup-agent.ts), served on the deployed developer API for a company on the core engine, AS the signed-in person:
//
//   GET  /v1/app/projects/{project}/setup-agent            where the project's setup run stands (the core's SetupAgentView) plus `canManage`, the waiting candidate (`apply`, with `draftedByRovara` when Rovara's automatic repair drafted it) and, for managers, the broken-setup card (`repair`, L4-RD)
//   POST /v1/app/projects/{project}/setup-agent            start a run, or RE-RUN one that ended ({ requestId }); 202 started, 200 a repeat of the same request id
//   POST /v1/app/projects/{project}/setup-agent/stop       stop the running run ({ requestId })
//   GET  /v1/app/projects/{project}/setup-agent/journal    the run's journal (`?after=<n>`) and the websites it asked for
//
//   POST /v1/app/projects/{project}/setup-agent/confirm    "Use this setup": a candidate revision from the run's verified commands, and its check on a fresh workspace (L4-D)
//   POST /v1/app/projects/{project}/setup-agent/discard    drop the waiting candidate ({ requestId })
//   POST /v1/app/projects/{project}/setup-agent/decide     approve or reject the waiting candidate once its check passed (L4-D, setup-approval.ts): a fresh step-up, then the risk-based
//                                                         approver rule (DEC 254z b), through the approval gate, bound to the candidate's digest and revision
//
// Confirm, discard and decide are served only where the deployment wires the hosted approval (`approval`): without it a confirm would leave a candidate nothing can approve.
//
// Rules:
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, a query, a body or a token claim; every key is the company's own (the runtime's).
//   - Who (DEC 254n 3, the rule of PR 16's `lifecycleAccess`): a live owner or admin of the company, or an administrator of the project, MANAGES (starts, re-runs, stops); a person who uses the project (a developer grant) READS the run and its journal; anyone else, another company's project, a missing one and a malformed name all answer
//     the same 404 "project not found". The standing is read live on every request, again inside the start (the start's own access check), and before every step the run takes
//     (`hostedTaskAccess.checkStep` for a setup run). A change by a reader is 403 in fixed words.
//   - One run per project: the core's conditional pointer write (`setupAgentPointerItem`) in the start's own transaction. A re-run of a working project only PROPOSES: the project's
//     commands change only after confirm, a passing check on a fresh workspace and an approval (apply.ts); a failed or stopped re-run never replaces a working setup.
//   - Every start, re-run and stop leaves an audit record naming the person and why they were allowed (the runtime's audit sink): a start's in the start's own
//     transaction; the others' before the act, so nothing is done when the record cannot be written.
//   - A start needs the company on the core for NEW tasks and the install's model gateway (which meters the run); otherwise a fixed 503 and nothing is written.
//   - Bodies are the core's strict schemas (a request id and nothing else for start and stop: limits, payer and goal never come from the client).
import { AgentXError, agentXError, isSystemOwnerId, type AuditEvent, type AuditSink, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { startTask } from "../core/task-flow/start.js";
import { cancelTask } from "../core/task-flow/cancel.js";
import { SetupAgentStartBodySchema, SetupAgentStopBodySchema, getSetupAgent, readState, startSetupAgent, stopSetupAgent, type SetupAgentDeps } from "../core/setup-agent/agent.js";
import type { SetupApplyDeps } from "../core/setup-agent/apply.js";
import { SETUP_APPLY_KIND, SetupConfirmBodySchema, confirmSetupAgent, discardSetupApply, readSetupApply, setupCandidateRisk, waitingSetupApply } from "../core/setup-agent/apply.js";
import { SETUP_RISK_APPROVER, setupApproverAllows, type SetupRisk } from "../core/setup-agent/setup-risk.js";
import type { GateResult } from "../core/decisions/approval-gate.js";
import { readRepairView } from "../core/setup-agent/repair-draft.js";
import { setupApproverRefusal, setupCardOf, setupDecisionRequestId, type HostedSetupApproval } from "./setup-approval.js";
import { z } from "zod";
import { readSetupJournal } from "../core/setup-agent/journal.js";
import { listHostAsks } from "../core/setup-agent/host-ask.js";
import { setupAgentKey } from "../core/setup-agent/keys.js";
import { ensureCoreInUse } from "./engine-stamp.js";

export const SETUP_RUN_PROJECT_NOT_FOUND = "project not found";
export const SETUP_RUN_NOT_ALLOWED = "Only company owners and admins, or this project's admins, can run the project's setup.";
export const SETUP_RUN_UNAVAILABLE = "Setting a project up with Rovara isn't available for this company yet.";
export const SETUP_RUN_UNREADABLE = "The project's setup could not be read just now. Try again.";
export const SETUP_RUN_AUDIT_UNAVAILABLE = "The record of this change could not be written, so nothing was done. Try again.";
export const SETUP_APPROVAL_UNAVAILABLE = "Approving a project's setup isn't available on this install yet.";
export const SETUP_NOTHING_WAITING = "There is no setup waiting for a decision. Open the project's setup again.";
export const SETUP_DECIDE_ON_A_PAGE = "A setup is decided right after you confirm it's you on the sign-in page: a tool that holds an API token cannot approve or reject. Confirm it's you, then try again within a few minutes.";
export const SETUP_PROOF_UNAVAILABLE = "Your approval could not be proved just now, so nothing was decided. Try again.";

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
  /** The code host's file read at a commit, for re-reading a proposal's citations. Absent: every item is `unchecked`. */
  readFile?: SetupAgentDeps["readFile"];
  /** L4-D: the hosted approval of a setup candidate (setup-approval.ts). Absent: confirm, discard and decide are not served. */
  approval?: HostedSetupApproval | undefined;
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
  /** The dev routes' step-up check (fresh for this company now), with the refusal's words; it throws the refusal. Absent: nothing is decided. */
  freshStepUp?: (refusal: string) => Promise<{ at: string; method: string }>;
}

const DecideBodySchema = z.object({
  /** The id the page was offered (`setup-<digest>-<revision>`, setup-approval.ts `setupDecisionRequestId`): its own namespace, apart from task decisions' ids. */
  requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u),
  outcome: z.enum(["approve", "reject"]),
  /** The candidate revision and digest the person saw. */
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  reason: z.string().max(500).optional(),
}).strict();
const DiscardBodySchema = z.object({ requestId: z.string().uuid() }).strict();

const SETUP_PATH = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|journal|confirm|discard|decide))?$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is the hosted setup run's. */
export function isSetupRunPath(path: string, method: string): boolean {
  const match = SETUP_PATH.exec(path);
  if (match === null) return false;
  const tail = match[2];
  if (method === "GET") return tail === undefined || tail === "journal";
  if (method === "POST") return tail === undefined || tail === "stop" || tail === "confirm" || tail === "discard" || tail === "decide";
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

/** The waiting candidate as the page shows it: its commands, its check, its risk and changes, who must approve it, and whether this person may. Undefined: nothing waits. */
async function applyView(input: HostedSetupRunInput, deps: SetupApplyDeps, project: string): Promise<Record<string, unknown> | undefined> {
  const apply = await readSetupApply(deps, project);
  if (apply === undefined || apply.state !== "checking") return undefined;
  const { risk, changes } = await setupCandidateRisk(input.flow.store, input.companyId, apply);
  let who: Awaited<ReturnType<HostedSetupApproval["standing"]>>;
  try { who = await input.wiring.approval!.standing(input.principal.personId, project); } catch { who = undefined; }
  const ready = apply.checkState.status === "ready";
  return {
    candidateRevision: apply.candidateRevision, baseRevision: apply.baseRevision, setup: apply.setup, readiness: apply.readiness,
    check: { status: apply.checkState.status, ...(apply.checkState.failedStep === undefined ? {} : { failedStep: apply.checkState.failedStep }) },
    risk, changes, approver: SETUP_RISK_APPROVER[risk],
    // L4-RD: the candidate was drafted by Rovara's automatic repair (its check ran as the project's system owner); a person still decides it, by the same rule.
    ...(isSystemOwnerId(apply.by) ? { draftedByRovara: true } : {}),
    canApprove: ready && setupApproverAllows(who, risk, "approve"), canReject: ready && setupApproverAllows(who, risk, "reject"),
    // The decision is offered only once the candidate's check passed.
    ...(ready ? { approval: { requestId: setupDecisionRequestId(apply.digest, apply.candidateRevision), revision: apply.candidateRevision, artifactDigest: apply.digest, kind: "setup", risk } } : {}),
  };
}

/** A gate's refusal as the route answers it: fixed words (the gate's own), the status by reason. */
function gateRefusal(result: Extract<GateResult, { status: "refused" }>): AgentXError {
  switch (result.reason) {
    case "stale": case "not_waiting": case "not_found": case "link_gone": return agentXError("CHANGE_STALE", result.detail);
    case "sign_in_not_fresh": case "expired": return agentXError("REAUTH_REQUIRED", result.detail);
    case "proof_already_used": case "request_id_reused": return agentXError("IDEMPOTENCY_CONFLICT", result.detail);
    case "invalid": case "unsupported": case "invalid_outcome": return agentXError("CONFIG_INVALID", result.detail);
    default: return agentXError("FORBIDDEN", result.detail);
  }
}

/** Approve or reject the waiting candidate: a fresh step-up, the live risk rule, the point's proof, then the gate (which loads the candidate again and re-checks the rule). */
async function decide(input: HostedSetupRunInput, approval: HostedSetupApproval, project: string, raw: unknown): Promise<BrokerResponse> {
  if (input.freshStepUp === undefined) throw agentXError("NOT_FOUND", SETUP_APPROVAL_UNAVAILABLE);
  const stepUp = await input.freshStepUp(SETUP_DECIDE_ON_A_PAGE);
  const body = parsed(DecideBodySchema, raw);
  const { flow, companyId } = input;
  const personId = input.principal.personId;
  const waiting = await waitingSetupApply(flow.store, companyId, project);
  if (waiting === undefined) throw agentXError("CHANGE_STALE", SETUP_NOTHING_WAITING);
  const risk: SetupRisk = (await setupCandidateRisk(flow.store, companyId, waiting)).risk;
  let who: Awaited<ReturnType<HostedSetupApproval["standing"]>>;
  try { who = await approval.standing(personId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_UNREADABLE); }
  if (!setupApproverAllows(who, risk, body.outcome)) throw agentXError("FORBIDDEN", setupApproverRefusal(risk, body.outcome));
  const card = setupCardOf(project, body.seen.artifactDigest);
  let credential: { method: string; token: string };
  try {
    credential = await approval.issue({ companyId, personId, stepUp, requestId: body.requestId, kind: "setup", project, revision: body.seen.revision, artifactDigest: body.seen.artifactDigest, outcome: body.outcome, card });
  } catch {
    throw agentXError("FORBIDDEN", SETUP_PROOF_UNAVAILABLE);
  }
  const result = await approval.gate.decide({
    companyId, kind: SETUP_APPLY_KIND, subjectId: project, requestId: body.requestId, outcome: body.outcome, seen: body.seen,
    credentials: [{ method: credential.method, token: credential.token }], card, ...(body.reason === undefined ? {} : { reason: body.reason }),
  });
  if (result.status === "refused") throw gateRefusal(result);
  const decision = body.outcome === "approve" ? "approved" : "rejected";
  return json(200, { project, decision, risk: result.record.risk, revision: result.record.revision, replayed: result.status === "replayed" });
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

    if (input.request.method === "GET" && tail === undefined) {
      const apply = input.wiring.approval === undefined ? undefined : await applyView(input, deps, project);
      // L4-RD: the admin card of a broken setup ("Approve new setup" / "Fix setup"), for the people who manage the project's setup only. Absent while the setup is not broken.
      const repair = standing.access === "manage" ? await readRepairView(deps, project) : undefined;
      return json(200, { ...(await getSetupAgent(deps, project)), canManage: standing.access === "manage", ...(apply === undefined ? {} : { apply }), ...(repair === undefined ? {} : { repair }) });
    }
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
    if (tail === "confirm" || tail === "discard" || tail === "decide") {
      const approval = input.wiring.approval;
      if (approval === undefined) throw agentXError("NOT_FOUND", SETUP_APPROVAL_UNAVAILABLE);
      if (tail === "confirm") {
        const body = parsed(SetupConfirmBodySchema, raw);
        await recorded(input, auditEvent(input, "setup_run.confirm_requested", `setup_run.confirm:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId }));
        return json(200, await confirmSetupAgent(deps, project, body, personId));
      }
      if (tail === "discard") {
        const body = parsed(DiscardBodySchema, raw);
        await recorded(input, auditEvent(input, "setup_run.discard_requested", `setup_run.discard:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId }));
        return json(200, { discarded: await discardSetupApply(deps, project, personId) });
      }
      return await decide(input, approval, project, raw);
    }
    if (tail === "stop") {
      const body = parsed(SetupAgentStopBodySchema, raw);
      await recorded(input, auditEvent(input, "setup_run.stop_requested", `setup_run.stop:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId }));
      const answer = await stopSetupAgent(deps, project, body, personId);
      return json(answer.status, { ...answer.view, canManage: true });
    }
    throw agentXError("NOT_FOUND", "route not found");
  } catch (error) {
    if (error instanceof AgentXError) {
      // The core names a missing project with its name; here every missing or unseen project reads the same.
      if (error.code === "PROJECT_NOT_FOUND") return errorAnswer(notFound());
      return errorAnswer(error);
    }
    throw error;
  }
}
