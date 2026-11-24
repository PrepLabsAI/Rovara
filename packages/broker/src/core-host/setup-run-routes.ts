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
//   GET  /v1/app/projects/{project}/setup-agent/eval          L4-EVC: the project's ONE eval card, in dollars (eval-card.ts)
//   POST /v1/app/projects/{project}/setup-agent/eval-approve  ONE approval: confirm the eval AND approve its spend in the same act (the live approver rule, the dollars the person saw)
//   POST /v1/app/projects/{project}/setup-agent/eval-wrapper   L4-EVW4 (DEC 254zzz43): a person's act on the wrapper card ({ requestId, action: open_pull_request | dismiss | reopen | check, selection? }). ONLY a person's POST opens a pull
//                                                         (one new file on a new branch, never merged by Rovara; owner, admin or project maintainer); `check` (look for the file on the default branch) is a read any member may ask
//   GET  /v1/app/projects/{project}/setup-agent/updates    L4-SC (DEC 254z c): the "Update setup" offers a merged plan's setup changes left (managers only; a reader sees none)
//   POST /v1/app/projects/{project}/setup-agent/updates/prepare   "Update setup": a candidate from the offer's items and its check (the same flow as confirm; approves nothing)
//   POST /v1/app/projects/{project}/setup-agent/updates/dismiss   "Not now" ({ requestId, taskId })
//   POST /v1/app/projects/{project}/setup-agent/eval-decide   approve or reject a waiting eval spend item (a changed eval that grew past its approved limit asks again)
//   POST /v1/app/projects/{project}/setup-agent/eval-health   the OPT-IN "Check my evals now": records the person's yes; nothing runs without it (eval-health-request.ts)
//   POST /v1/app/projects/{project}/setup-agent/decide     approve or reject the waiting candidate once its check passed (L4-D, setup-approval.ts): the risk-based
//                                                         approver rule (DEC 254z b), through the approval gate, bound to the candidate's digest and revision
//   GET  /v1/app/projects/{project}/setup-agent/limits    the project's own run limits, the company's caps, what a run started now would use, and the bounds (any live role on the project reads; limits.ts)
//   PUT  /v1/app/projects/{project}/setup-agent/limits    set the project's own limits ({ requestId, expectedRevision, limits }): the SAME people who start a run (a live company owner or admin, or the project's administrator), audited,
//                                                         revision-checked, bounded by the contract's maxima and the company's cap; the next run starts with them (a run going keeps the ones it began with)
//   POST /v1/app/projects/{project}/setup-agent/host-decide  allow or refuse a website a setup run asked for (L4-SF d): the high-risk rule (a company owner or admin, either answer), through
//                                                         the approval gate, bound to the exact ask (its host and when it was asked); the journal lists each open ask's `approval` and `canDecide`
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
import { AgentXError, SetupHostSchema, agentXError, isSystemOwnerId, type AuditEvent, type AuditSink, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { startTask } from "../core/task-flow/start.js";
import { cancelTask } from "../core/task-flow/cancel.js";
import { EvalDiscoveryConfirmBodySchema, EvalWrapperActionBodySchema } from "@agentx/contracts";
import { readEvalCard } from "../core/setup-agent/eval-card.js";
import { confirmEvalDiscovery, type EvalDiscoveryConfirmDeps } from "../core/setup-agent/eval-discovery.js";
import { EvalHealthRequestBodySchema, requestEvalHealthCheck } from "../core/setup-agent/eval-health-request.js";
import { EVAL_SPEND_KIND, readEvalSpendRecord, roleFor as evalRoleFor } from "../core/setup-agent/eval-spend.js";
import { detectEvalWrappers, dismissEvalWrapper, openEvalWrapperPullRequest, refreshEvalWrappers, reopenEvalWrapper, type EvalWrapperDeps } from "../core/setup-agent/eval-wrapper.js";
import { readEvalWrapperCards } from "../core/setup-agent/eval-wrapper-card.js";
import { readEvalDiscovery } from "../core/setup-agent/eval-discovery.js";
import { developerIdOf } from "../core/sessions/create.js";
import { SetupAgentStartBodySchema, SetupAgentStopBodySchema, getSetupAgent, readState, startSetupAgent, stopSetupAgent, type SetupAgentDeps } from "../core/setup-agent/agent.js";
import type { SetupApplyDeps } from "../core/setup-agent/apply.js";
import { SETUP_APPLY_KIND, SetupConfirmBodySchema, confirmSetupAgent, discardSetupApply, readSetupApply, setupCandidateRisk, waitingSetupApply } from "../core/setup-agent/apply.js";
import { SETUP_RISK_APPROVER, setupApproverAllows, setupHostApproverAllows, type SetupRisk } from "../core/setup-agent/setup-risk.js";
import { dismissSetupUpdate, markSetupUpdateApplied, prepareSetupUpdate, readSetupUpdates } from "../core/setup-agent/plan-update.js";
import type { GateResult } from "../core/decisions/approval-gate.js";
import { readRepairView } from "../core/setup-agent/repair-draft.js";
import { SETUP_HOST_NEEDS_ADMIN, evalSpendCardOf, setupApproverRefusal, setupCardOf, setupDecisionRequestId, setupHostCardOf, type HostedSetupApproval } from "./setup-approval.js";
import { z } from "zod";
import { readSetupJournal } from "../core/setup-agent/journal.js";
import { HOST_ASK_REVISION, SETUP_HOST_KIND, hostAskDigest, hostAskSubjectId, hostDecisionRequestId, listHostAsks, readOpenHostAsk } from "../core/setup-agent/host-ask.js";
import { setupAgentKey } from "../core/setup-agent/keys.js";
import { ensureCoreInUse } from "./engine-stamp.js";
import { setupStateOf, startProjectSetupCheck } from "../core/setup-agent/check.js";
import { resumeSetupPausedTasks } from "../core/setup-agent/auto-resume.js";
import { log as logTaskFlow } from "../core/task-flow/support.js";
import { setupRepairViewOf } from "../core/setup-agent/repair-view.js";
import { putSetupLimits, readSetupLimits, setupLimitSettingReader } from "../core/setup-agent/limits.js";

export const SETUP_RUN_PROJECT_NOT_FOUND = "project not found";
export const SETUP_RUN_NOT_ALLOWED = "Only company owners and admins, or this project's admins, can run the project's setup.";
export const SETUP_LIMITS_NOT_ALLOWED = "Only company owners and admins, or this project's admins, can change the project's setup limits.";
export const SETUP_RUN_UNAVAILABLE = "Setting a project up with Rovara isn't available for this company yet.";
export const SETUP_RUN_UNREADABLE = "The project's setup could not be read just now. Try again.";
export const SETUP_RUN_AUDIT_UNAVAILABLE = "The record of this change could not be written, so nothing was done. Try again.";
export const SETUP_APPROVAL_UNAVAILABLE = "Approving a project's setup isn't available on this install yet.";
export const SETUP_NOTHING_WAITING = "There is no setup waiting for a decision. Open the project's setup again.";
export const EVAL_WRAPPER_UNAVAILABLE = "Setting up the file Rovara needs to read your eval isn't available on this install yet.";
/** "Check now" looks at the code host at most once in this long per eval (any member may press it; the host's quota is the company's). */
const CHECK_NOW_FLOOR_MS = 15_000;
export const EVAL_WRAPPER_ROLE = "Only a company owner, admin or project maintainer can ask Rovara to open a pull request for the eval's file, set it aside, or approve its test run.";
export const EVAL_DECIDE_STALE = "That eval approval changed since you looked. Read it again.";
export const EVAL_APPROVAL_UNAVAILABLE = "Approving an eval's spend isn't available on this install yet.";
export const SETUP_NO_HOST_WAITING = "That address is not waiting for a decision any more. Open the project's setup again.";
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
  /**
   * L4-EVC: the eval card (DEC 254zzz20). The company's monthly eval cap (the bound `eval-reservation` adapter's source; absent: no eval can be confirmed here) and the code host's file read for the
   * broker's own hashing of the confirmed files. Served only together with `approval` (whose gate decides the eval spend item and whose members read the live roles).
   */
  eval?: { monthlyCap?: EvalDiscoveryConfirmDeps["monthlyCap"];
    /** L4-T3: whether the project's own AI provider is connected (the bound adapter's answer). Absent: the card says neither, as before. */
    providerConnected?: (scope: { company: string; project: string }) => Promise<boolean | undefined>; readFile?: EvalDiscoveryConfirmDeps["readFile"];
    /** L4-EVW4: the project's repositories as code host targets (`createEvalWrapperTargets`), for the wrapper file's detection on the default branch and the pull request a person asks for. Absent: nothing is read from or written to a host. */
    wrapperTargets?: EvalWrapperDeps["targets"];
    /** D5: true only where a health runner reads the person's yes (`readEvalHealthRequest`). Absent: the card shows no health button and `eval-health` is not served. No deployment wires one yet. */
    healthRuns?: boolean;
    /** L4-E12: whether this install's test services are off right now (the hosted broker's `!testServicesEnabled(env)`), for the free dry run's words. Absent: read as on. */
    testServicesOff?: () => boolean;
    /** L4-EVH: starts the health run for the project's waiting yes (the broker claims it and hands it to a worker). Best effort; never throws, and the person's answer does not wait on the worker. Absent: nothing starts here (the card shows no button). */
    healthRun?: (project: string) => Promise<unknown> } | undefined;
  /** A person's display name, for "stopped by". Absent or unknown: "Unknown". */
  displayName?: ((personId: string) => Promise<string | undefined>) | undefined;
}

export interface HostedSetupRunInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  principal: TaskStartCaller["principal"];
  client?: string | undefined;
  /** Set only by the broker's sign-in for the Rovara website's own client (DEC 254zzz91): a change that raises a setup limit needs it. */
  webApp?: boolean | undefined;
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedSetupRunWiring;
  /** The audit sink for this request (the dev routes' `auditFor`, else the runtime's). */
  audit: AuditSink;
  /** Whether the switch sends this company's NEW tasks to the core. False: a start is refused. */
  startsNewTasks: boolean;
  now: () => number;
}

const DecideBodySchema = z.object({
  /** The id the page was offered (`setup-<digest>-<revision>`, setup-approval.ts `setupDecisionRequestId`): its own namespace, apart from task decisions' ids. */
  requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u),
  outcome: z.enum(["approve", "reject"]),
  /** The candidate revision and digest the person saw. */
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  reason: z.string().max(500).optional(),
}).strict();
const HostDecideBodySchema = z.object({
  /** The id the page was offered for this ask (`host-<hash>`, host-ask.ts `hostDecisionRequestId`): its own namespace, apart from task and setup decisions' ids. */
  requestId: z.string().regex(/^host-[A-Za-z0-9_-]{2,122}$/u),
  host: SetupHostSchema,
  outcome: z.enum(["approve", "reject"]),
  /** The ask as the person saw it: its one revision and digest (the host and when it was asked). */
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  reason: z.string().max(500).optional(),
}).strict();
const DiscardBodySchema = z.object({ requestId: z.string().uuid() }).strict();
/** L4-EVC: a decision on a waiting eval spend item: the offer the card showed (its request id, revision and digest). */
const EvalDecideBodySchema = z.object({
  requestId: z.string().regex(/^eval-[a-f0-9]{40}-[0-9]{1,15}$/u),
  outcome: z.enum(["approve", "reject"]),
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict();
/** L4-SC: the task whose offer the person pressed (a task id, as every key names one). */
const UpdateBodySchema = z.object({ requestId: z.string().uuid(), taskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u) }).strict();

const SETUP_PATH = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|journal|confirm|discard|decide|eval|eval-approve|eval-decide|eval-health|eval-wrapper|updates|updates\/prepare|updates\/dismiss|host-decide|limits))?$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is the hosted setup run's. */
export function isSetupRunPath(path: string, method: string): boolean {
  const match = SETUP_PATH.exec(path);
  if (match === null) return false;
  const tail = match[2];
  if (method === "GET") return tail === undefined || tail === "journal" || tail === "updates" || tail === "eval" || tail === "limits";
  if (method === "POST") return tail === undefined || tail === "stop" || tail === "confirm" || tail === "discard" || tail === "decide" || tail === "updates/prepare" || tail === "updates/dismiss" || tail === "host-decide" || tail === "eval-approve" || tail === "eval-decide" || tail === "eval-health" || tail === "eval-wrapper";
  if (method === "PUT") return tail === "limits";
  return false;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", SETUP_RUN_PROJECT_NOT_FOUND);

/** The project's name from the path: a malformed escape or name is a project that does not exist. */
function projectOf(raw: string): string {
  let project: string;
  try { project = decodeURIComponent(raw); } catch { throw notFound(); }
  if (!PROJECT_NAME.test(project)) throw notFound();
  return project;
}

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

/** Whether this person is a live company owner or admin right now (the rule browser testing's changes need on every route). A read that fails is no. */
async function isCompanyAdminNow(input: HostedSetupRunInput, project: string): Promise<boolean> {
  try { return input.wiring.approval !== undefined && setupHostApproverAllows(await input.wiring.approval.standing(input.principal.personId, project)); } catch { return false; }
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
    // L4-SC: the fakes the candidate sets (the approver sees which variable is redirected and from which spec), bound into the digest the approval names.
    ...(apply.fakes === undefined ? {} : { fakes: apply.fakes }),
    ...(apply.promptLocations.length === 0 ? {} : { promptLocations: apply.promptLocations }),
    // Browser testing: this candidate is a project's browser testing setup (decided on its own page, by a live company owner or admin), not a setup run's commands.
    ...(apply.browserTesting === undefined ? {} : { browserTesting: true }),
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
    case "expired": return agentXError("REAUTH_REQUIRED", result.detail);
    case "proof_already_used": case "request_id_reused": return agentXError("IDEMPOTENCY_CONFLICT", result.detail);
    case "invalid": case "unsupported": case "invalid_outcome": return agentXError("CONFIG_INVALID", result.detail);
    default: return agentXError("FORBIDDEN", result.detail);
  }
}

/** Approve or reject the waiting candidate: the live risk rule, the point's proof, then the gate (which loads the candidate again and re-checks the rule). */
async function decide(input: HostedSetupRunInput, approval: HostedSetupApproval, project: string, raw: unknown): Promise<BrokerResponse> {
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
    credential = await approval.issue({ companyId, personId, requestId: body.requestId, kind: "setup", project, revision: body.seen.revision, artifactDigest: body.seen.artifactDigest, outcome: body.outcome, card });
  } catch {
    throw agentXError("FORBIDDEN", SETUP_PROOF_UNAVAILABLE);
  }
  const result = await approval.gate.decide({
    companyId, kind: SETUP_APPLY_KIND, subjectId: project, requestId: body.requestId, outcome: body.outcome, seen: body.seen,
    credentials: [{ method: credential.method, token: credential.token }], card, ...(body.reason === undefined ? {} : { reason: body.reason }),
  });
  if (result.status === "refused") throw gateRefusal(result);
  // L4-SC: a candidate that came from a merged plan's "Update setup" retires its offer once approved (best effort; a rejected one leaves the offer to try again).
  if (body.outcome === "approve" && result.status !== "replayed") await markSetupUpdateApplied({ store: flow.store, companyId, now: input.now }, project, waiting.reply, personId);
  if (body.outcome === "approve") void resumeSetupPausedTasks(flow, project, { kind: "approved", revision: body.seen.revision }).catch((error: unknown) => logTaskFlow(flow, { event: "setup_apply.resume_failed", error: error instanceof Error ? error.name : "unknown" }));
  const decision = body.outcome === "approve" ? "approved" : "rejected";
  return json(200, { project, decision, risk: result.record.risk, revision: result.record.revision, replayed: result.status === "replayed" });
}

/**
 * Allow or refuse a website the setup run asked for (L4-SF d): the high-risk rule on the person's live standing (a company owner or admin, either answer), the point's proof bound to the
 * exact ask, then the gate (which loads the ask again, re-checks the rule and the host's own refusal list on approval). The ask is found by the project and host the person named, in THIS company only.
 */
async function decideHost(input: HostedSetupRunInput, approval: HostedSetupApproval, project: string, raw: unknown): Promise<BrokerResponse> {
  const body = parsed(HostDecideBodySchema, raw);
  const { flow, companyId } = input;
  const personId = input.principal.personId;
  let who: Awaited<ReturnType<HostedSetupApproval["standing"]>>;
  try { who = await approval.standing(personId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_UNREADABLE); }
  if (!setupHostApproverAllows(who)) throw agentXError("FORBIDDEN", SETUP_HOST_NEEDS_ADMIN);
  const host = body.host.toLowerCase();
  const ask = await readOpenHostAsk({ store: flow.store, now: input.now }, companyId, project, host);
  if (ask === undefined) throw agentXError("CHANGE_STALE", SETUP_NO_HOST_WAITING);
  // The decision is made on THIS ask as it stands: the id and the digest are the ones the broker derives from it, so a person's earlier look at another ask of the same host (an older one) decides nothing.
  if (body.requestId !== hostDecisionRequestId(ask) || body.seen.revision !== HOST_ASK_REVISION || body.seen.artifactDigest !== hostAskDigest(ask)) throw agentXError("CHANGE_STALE", SETUP_NO_HOST_WAITING);
  const subjectId = hostAskSubjectId(companyId, project, ask.host);
  const card = setupHostCardOf(subjectId, body.seen.artifactDigest);
  let credential: { method: string; token: string };
  try {
    credential = await approval.issueHost({ companyId, personId, requestId: body.requestId, kind: "setup_host", subjectId, revision: body.seen.revision, artifactDigest: body.seen.artifactDigest, outcome: body.outcome, card });
  } catch {
    throw agentXError("FORBIDDEN", SETUP_PROOF_UNAVAILABLE);
  }
  const result = await approval.gate.decide({
    companyId, kind: SETUP_HOST_KIND, subjectId, requestId: body.requestId, outcome: body.outcome, seen: body.seen,
    credentials: [{ method: credential.method, token: credential.token }], card, ...(body.reason === undefined ? {} : { reason: body.reason }),
  });
  if (result.status === "refused") throw gateRefusal(result);
  return json(200, { project, host: ask.host, decision: body.outcome === "approve" ? "approved" : "refused", replayed: result.status === "replayed" });
}

/**
 * L4-EVC: one decision on the project's eval spend item, as the person: the proof of this one act (bound to the item's request id, revision, digest, the answer and its card), then the
 * ONE approval gate, whose eval subject re-reads the person's live role inside the decision. Throws the gate's fixed refusal.
 */
async function decideEvalItem(input: HostedSetupRunInput, approval: HostedSetupApproval, project: string, act: { requestId: string; outcome: "approve" | "reject"; seen: { revision: number; artifactDigest: string } }, principal: { personId: string }): Promise<void> {
  const { companyId } = input;
  const card = evalSpendCardOf(project, act.seen.artifactDigest);
  let credential: { method: string; token: string };
  try {
    credential = await approval.issueEval({ companyId, personId: principal.personId, requestId: act.requestId, kind: EVAL_SPEND_KIND, project, revision: act.seen.revision, artifactDigest: act.seen.artifactDigest, outcome: act.outcome, card });
  } catch {
    throw agentXError("FORBIDDEN", SETUP_PROOF_UNAVAILABLE);
  }
  const result = await approval.gate.decide({
    companyId, kind: EVAL_SPEND_KIND, subjectId: project, requestId: act.requestId, outcome: act.outcome, seen: act.seen,
    credentials: [{ method: credential.method, token: credential.token }], card, ...(act.outcome === "reject" ? { reason: "Not now (eval)" } : {}),
  });
  if (result.status === "refused") throw gateRefusal(result);
}

/** L4-EVW4: the wrapper card's seams for this request: the host's targets, and the audit record written before any write (the PERSON who asked, and why they were allowed). */
function wrapperDeps(input: HostedSetupRunInput, project: string, basis: SetupRunBasis, requestId?: string): EvalWrapperDeps {
  const targets = input.wiring.eval!.wrapperTargets!;
  return {
    store: input.flow.store, companyId: input.companyId, now: input.now, targets,
    audit: async (event) => { await recorded(input, auditEvent(input, event.action, `${event.action}:${input.companyId}:${project}:${input.principal.personId}:${requestId ?? input.now()}:${event.details["digest"] ?? ""}`, project, basis, event.details)); },
  };
}

/**
 * L4-EVW4 (DEC 254zzz43): a person's act on the wrapper card. `basis` is the manager's standing (absent: a member who may only look). ONLY `open_pull_request` writes to the repository, and only for the person's own click:
 * the audit (written before the host write) names them. `dismiss` and `reopen` set the card aside or back (audited). `check` looks for the file on the default branch (a read; any member may ask it).
 */
async function evalWrapperAct(input: HostedSetupRunInput, project: string, basis: SetupRunBasis | undefined, raw: unknown): Promise<BrokerResponse> {
  const { flow, companyId } = input;
  const approval = input.wiring.approval;
  const targets = input.wiring.eval?.wrapperTargets;
  if (approval === undefined || targets === undefined) throw agentXError("NOT_FOUND", EVAL_WRAPPER_UNAVAILABLE);
  const body = parsed(EvalWrapperActionBodySchema, raw);
  const found = await readEvalDiscovery({ store: flow.store, companyId }, project);
  if (found === undefined) throw agentXError("NOT_FOUND", "There is no eval report for this project's latest setup run.");
  // The same people who confirm an eval (read live): a company owner or admin, or a maintainer of this project.
  const manager = basis !== undefined && await evalRoleFor({ members: approval.evalMembers }, project, { companyId, developerId: developerIdOf(input.principal), principal: input.principal }) !== undefined;
  if (body.action !== "check" && !manager) throw agentXError("FORBIDDEN", EVAL_WRAPPER_ROLE);
  const deps = wrapperDeps(input, project, basis ?? "project-admin", body.requestId);
  let outcome: Awaited<ReturnType<typeof openEvalWrapperPullRequest>> | undefined;
  if (body.action === "check") {
    await refreshEvalWrappers(deps, project);
    await detectEvalWrappers(deps, project, found.report, { force: true, floorMs: CHECK_NOW_FLOOR_MS });
  } else if (body.action === "dismiss") {
    await dismissEvalWrapper(deps, project, { reportDigest: found.reportDigest, by: input.principal.personId });
  } else if (body.action === "reopen") {
    await reopenEvalWrapper(deps, project, { by: input.principal.personId });
  } else {
    // The person's click is the ONLY thing that opens a pull request, and the audit (written before the host write) names them.
    outcome = await openEvalWrapperPullRequest(deps, project, { report: found.report, selection: body.selection!, taskId: found.taskId, by: input.principal.personId });
  }
  return json(200, {
    project, action: body.action,
    ...(outcome === undefined ? {} : { outcome: { selection: outcome.selection, state: outcome.state, ...(outcome.failure === undefined ? {} : { failure: outcome.failure }), ...(outcome.number === undefined ? {} : { number: outcome.number }), ...(outcome.url === undefined ? {} : { url: outcome.url }) } }),
    wrappers: await readEvalWrapperCards({ store: flow.store, companyId }, project, { reportDigest: found.reportDigest, report: found.report }, manager),
  });
}

/** The project's setup-run limits: any live role on the project reads; only a person who manages the project's setup (read live by the caller), the same people who start a run, changes them. */
async function limitsRoute(input: HostedSetupRunInput, standing: SetupRunStanding, project: string): Promise<BrokerResponse> {
  const deps = { store: input.flow.store, companyId: input.companyId, now: input.now };
  if (input.request.method === "GET") return json(200, await readSetupLimits(deps, project));
  if (standing.access !== "manage") throw agentXError("FORBIDDEN", SETUP_LIMITS_NOT_ALLOWED);
  return json(200, await putSetupLimits(deps, project, bodyOf(input.request), input.principal.personId, standing.basis, input.audit, input.webApp === true));
}

/** One request on a hosted setup-run path (`isSetupRunPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedSetupRun(input: HostedSetupRunInput): Promise<BrokerResponse> {
  try {
    const match = SETUP_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    const project = projectOf(match[1]!);
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
      // The project's own limits (cut to the company's cap), read when a run starts and for the page's "limits" of a project with no run.
      limitSetting: setupLimitSettingReader({ store: flow.store, companyId }),
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
          // The shared startModelCheck writes the in-use mark only after readiness passes.
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
          const started = await startTask(setupDeps, caller, { requestId: request.requestId, project: request.project, instructions: request.text, title: `Set up ${request.project}` }, { setupAgent: { limits: request.limits, seenTaskId: request.seenTaskId, carryOver: request.carryOver } });
          return { taskId: started.task.taskId, duplicate: started.duplicate };
        },
        async cancel(request) { await cancelTask(flow, request.taskId); },
      },
    };

    if (tail === "limits") return await limitsRoute(input, standing, project);
    if (input.request.method === "GET" && tail === "eval") {
      const approval = input.wiring.approval;
      if (approval === undefined || input.wiring.eval === undefined) throw agentXError("NOT_FOUND", EVAL_APPROVAL_UNAVAILABLE);
      // L4-EVW4: where each wrapper pull request stands, and whether the file is on the default branch (whoever put it there), is READ from the host first (bounded, a young check is left as it is; a failed read changes nothing).
      if (input.wiring.eval.wrapperTargets !== undefined) {
        const reads = { store: flow.store, companyId, now: input.now, targets: input.wiring.eval.wrapperTargets };
        await refreshEvalWrappers(reads, project);
        const latest = await readEvalDiscovery({ store: flow.store, companyId }, project);
        if (latest !== undefined) await detectEvalWrappers(reads, project, latest.report);
      }
      return json(200, { project, ...(await readEvalCard({ store: flow.store, companyId, members: approval.evalMembers, monthlyCap: input.wiring.eval.monthlyCap, providerConnected: input.wiring.eval.providerConnected, healthRuns: input.wiring.eval.healthRuns, testServicesOff: input.wiring.eval.testServicesOff, now: input.now }, project, input.principal)) });
    }
    if (input.request.method === "GET" && tail === undefined) {
      const apply = input.wiring.approval === undefined ? undefined : await applyView(input, deps, project);
      // L4-RD: the admin card of a broken setup ("Approve new setup" / "Fix setup"), for the people who manage the project's setup only. Absent while the setup is not broken.
      const repair = standing.access === "manage" ? await readRepairView(deps, project) : undefined;
      return json(200, { ...(await getSetupAgent(deps, project)), canManage: standing.access === "manage", ...(apply === undefined ? {} : { apply }), ...(repair === undefined ? {} : { repair }) });
    }
    if (input.request.method === "GET" && tail === "updates") {
      // The offers are for the people who manage the project's setup (and only where a candidate can be approved); a reader sees none, and no other company's or project's.
      const offers = standing.access === "manage" && input.wiring.approval !== undefined ? await readSetupUpdates(deps, project) : [];
      return json(200, { offers, canManage: standing.access === "manage" });
    }
    if (input.request.method === "GET" && tail === "journal") {
      const after = Number(new URL(input.request.path, "http://core").searchParams.get("after") ?? "0");
      if (!Number.isInteger(after) || after < 0 || after > 400) throw agentXError("CONFIG_INVALID", "after: a journal position");
      const state = await readState(deps, project, latest.definition.revision);
      // An open ask carries what the person decides it on (L4-SF d): the id and digest of the ask as it stands, and whether THIS person may (a company owner or admin, read now).
      let mayDecide = false;
      if (input.wiring.approval !== undefined) {
        try { mayDecide = setupHostApproverAllows(await input.wiring.approval.standing(input.principal.personId, project)); } catch { mayDecide = false; }
      }
      const asks = (await listHostAsks({ store: flow.store, now: input.now }, companyId, project, ["open", "approved", "refused"])).slice(0, 50)
        .map((ask) => ({
          host: ask.host, status: ask.state, ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }), ...(ask.from === undefined ? {} : { from: ask.from }),
          ...(ask.state === "open" && input.wiring.approval !== undefined ? { canDecide: mayDecide, approval: { requestId: hostDecisionRequestId(ask), revision: HOST_ASK_REVISION, artifactDigest: hostAskDigest(ask), kind: "setup_host", risk: "high" } } : {}),
        }));
      if (state.pointer === undefined) return json(200, { status: state.view.status, entries: [], hostAsks: asks });
      return json(200, { status: state.view.status, entries: await readSetupJournal({ store: flow.store }, { orgId: companyId, project, taskId: state.pointer.taskId }, after), hostAsks: asks });
    }
    if (input.request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    // Every change: only a person who manages the project's setup. The one exception is the wrapper card's "Check now" (a read of the default branch, which writes nothing): any member who can see the project may ask it.
    if (standing.access !== "manage" && tail === "eval-wrapper") return await evalWrapperAct(input, project, undefined, bodyOf(input.request));
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
    if (tail === "confirm" || tail === "discard" || tail === "decide" || tail === "updates/prepare" || tail === "updates/dismiss" || tail === "host-decide") {
      const approval = input.wiring.approval;
      if (approval === undefined) throw agentXError("NOT_FOUND", SETUP_APPROVAL_UNAVAILABLE);
      if (tail === "updates/prepare") {
        const body = parsed(UpdateBodySchema, raw);
        await recorded(input, auditEvent(input, "setup_run.update_requested", `setup_run.update:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId, taskId: body.taskId }));
        return json(200, await prepareSetupUpdate(deps, project, body, personId));
      }
      if (tail === "updates/dismiss") {
        const body = parsed(UpdateBodySchema, raw);
        await recorded(input, auditEvent(input, "setup_run.update_dismissed", `setup_run.update_dismissed:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId, taskId: body.taskId }));
        return json(200, { dismissed: await dismissSetupUpdate(deps, project, body, personId) });
      }
      if (tail === "confirm") {
        const body = parsed(SetupConfirmBodySchema, raw);
        await recorded(input, auditEvent(input, "setup_run.confirm_requested", `setup_run.confirm:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId }));
        return json(200, await confirmSetupAgent(deps, project, body, personId));
      }
      if (tail === "discard") {
        const body = parsed(DiscardBodySchema, raw);
        await recorded(input, auditEvent(input, "setup_run.discard_requested", `setup_run.discard:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId }));
        return json(200, { discarded: await discardSetupApply(deps, project, personId, undefined, { mayDiscardBrowserTesting: await isCompanyAdminNow(input, project) }) });
      }
      if (tail === "host-decide") return await decideHost(input, approval, project, raw);
      return await decide(input, approval, project, raw);
    }
    if (tail === "eval-wrapper") return await evalWrapperAct(input, project, basis, raw);
    if (tail === "eval-approve" || tail === "eval-decide" || tail === "eval-health") {
      const approval = input.wiring.approval;
      const evalWiring = input.wiring.eval;
      if (approval === undefined || evalWiring === undefined) throw agentXError("NOT_FOUND", EVAL_APPROVAL_UNAVAILABLE);
      const stamp = String(input.now());
      if (tail === "eval-health") {
        if (evalWiring.healthRuns !== true) throw agentXError("NOT_FOUND", EVAL_APPROVAL_UNAVAILABLE);
        // The opt-in (D5): a person's yes, kept as one request row. Nothing runs here; the host's health runner reads the row.
        const body = parsed(EvalHealthRequestBodySchema, raw);
        await recorded(input, auditEvent(input, "eval.health_requested", `eval.health:${companyId}:${project}:${personId}:${body.requestId}`, project, basis, { requestId: body.requestId }));
        const asked = await requestEvalHealthCheck({ store: flow.store, companyId, now: input.now, members: approval.evalMembers }, project, body, input.principal);
        // The yes is kept; now the broker re-reads everything it rested on and starts the run (a repeat of the same yes starts nothing again).
        if (!asked.duplicate) await Promise.resolve(evalWiring.healthRun?.(project)).catch(() => undefined);
        return json(200, { project, ...asked });
      }
      if (tail === "eval-decide") {
        const body = parsed(EvalDecideBodySchema, raw);
        // The offer is the waiting item's own (its digest and revision), never an id the card did not show.
        const waiting = await readEvalSpendRecord({ store: flow.store, companyId }, project);
        if (waiting === undefined || body.requestId !== `eval-${waiting.digest.slice(0, 40)}-${String(waiting.revision)}`) throw agentXError("CHANGE_STALE", EVAL_DECIDE_STALE);
        await recorded(input, auditEvent(input, "eval.spend_decision_requested", `eval.decide:${companyId}:${project}:${personId}:${stamp}`, project, basis, { outcome: body.outcome }));
        await decideEvalItem(input, approval, project, body, input.principal);
        return json(200, { project, decision: body.outcome === "approve" ? "approved" : "rejected" });
      }
      // ONE approval: confirm the eval and approve its spend in the same act. The body names the dollars the person saw; the broker holds them against its own figures.
      const body = parsed(EvalDiscoveryConfirmBodySchema, raw);
      if (body.approve !== true) throw agentXError("CONFIG_INVALID", "approve: this route confirms and approves in one act");
      await recorded(input, auditEvent(input, "eval.approve_requested", `eval.approve:${companyId}:${project}:${personId}:${stamp}`, project, basis, { taskId: body.taskId }));
      const answer = await confirmEvalDiscovery({
        store: flow.store, companyId, now: input.now, members: approval.evalMembers, monthlyCap: evalWiring.monthlyCap, readFile: evalWiring.readFile, latest: (name) => deps.latest(name),
        approve: (offer, principal) => decideEvalItem(input, approval, project, { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }, principal),
      }, project, body, input.principal);
      return json(200, { project, state: answer.evalSpend?.state, ...(answer.evalSpend?.card === undefined ? {} : { perPr: answer.evalSpend.card.perPr, monthly: answer.evalSpend.card.monthly, carried: answer.evalSpend.card.carried === true }) });
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

// ---- "Re-check setup" (L4-P1, the Thursday fallback): the project's plain setup check, on a fresh machine, started by a person.
//
//   GET  /v1/app/projects/{project}/setup-check    where the project's setup check stands (the core's `SetupState`, plus `canManage` and, while the setup is broken, `repair`: the "Setup needs repair" card); any live role on the project reads it
//   POST /v1/app/projects/{project}/setup-check    start the check ({ requestId } and nothing else): a person who MANAGES the project's setup (a company owner or admin, or the project's administrator), read now.
//                                                  202 started, 200 a repeat of the same request id, 409 when a check of this project is already running.
// It is an ordinary PERSON-started check (the person is the starter and the record says so): no system owner, no flag, no AI, no model key. It is the way to prove the re-check on staging and the button a manager
// presses when the automatic re-check has not run. The audit record is written BEFORE the start, so nothing is started when it cannot be written. A start needs the company on the core for new tasks.
const SETUP_CHECK_PATH = /^\/v1\/app\/projects\/([^/]+)\/setup-check$/u;
const SetupCheckBodySchema = z.object({ requestId: z.string().uuid() }).strict();

/** Whether this method and path is the hosted "Re-check setup" route. */
export function isSetupCheckPath(path: string, method: string): boolean {
  return SETUP_CHECK_PATH.test(path) && (method === "GET" || method === "POST");
}

/** One request on the hosted setup-check path (`isSetupCheckPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedSetupCheck(input: HostedSetupRunInput): Promise<BrokerResponse> {
  try {
    const match = SETUP_CHECK_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!PROJECT_NAME.test(project)) throw notFound();
    const standing = await standingOf(input, project);
    if (standing.access === "none") throw notFound();
    const { flow, companyId } = input;
    // The project is read in the caller's company only: another company's project of the same name is never this one.
    const latest = await flow.projects.latest(project);
    if (latest === undefined) throw notFound();
    if (input.request.method === "GET") {
      // L4-U5: the setup state, who may act (read live above), and, while the setup is broken, the "Setup needs repair" card in the words every surface shares. The card's actions are empty for a person who may not act.
      const canManage = standing.access === "manage";
      const repair = await setupRepairViewOf({ flow, store: flow.store, companyId, now: input.now }, project, { canManage }).catch(() => undefined);
      return json(200, { ...(await setupStateOf(flow, project, latest.definition)), canManage, ...(repair === undefined ? {} : { repair }) });
    }
    if (input.request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    if (standing.access !== "manage") throw agentXError("FORBIDDEN", SETUP_RUN_NOT_ALLOWED);
    const body = parsed(SetupCheckBodySchema, bodyOf(input.request));
    if (!input.startsNewTasks) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_UNAVAILABLE);
    const personId = input.principal.personId;
    await recorded(input, auditEvent(input, "setup_check.requested", `setup_check.requested:${companyId}:${project}:${personId}:${body.requestId}`, project, standing.basis, { requestId: body.requestId }));
    await ensureCoreInUse(flow.store, companyId);
    const started = await startProjectSetupCheck(flow, { project, requestId: body.requestId, startedBy: personId });
    return json(started.duplicate ? 200 : 202, { workspaceId: started.workspaceId });
  } catch (error) {
    if (error instanceof AgentXError) {
      if (error.code === "PROJECT_NOT_FOUND") return errorAnswer(notFound());
      return errorAnswer(error);
    }
    throw error;
  }
}
