// Browser testing in a project's setup (owner decisions 417, 420, 421), on the hosted core. The route family `/v1/app/projects/{project}/browser-testing`, served AS the signed-in person:
//
//   GET    ``          the page's read (see `BrowserTestingView`): what the repository says, the choices, the waiting change, what is in force, Pause, the faults
//   POST   `/refresh`  { requestId }                                   create or refresh the draft from the repository as it is now
//   PUT    `/draft`    { requestId, expectedDraftRevision, proof?, runTimeoutMs? }
//   POST   `/check`    { requestId, expectedDraftRevision }            store the candidate and start the commands check on it
//   POST   `/decision` { requestId, outcome, seen: { revision, artifactDigest } }   approve or reject, through the ONE approval gate
//   POST   `/discard`  { requestId }                                   drop a waiting browser testing change
//   POST   `/pause`, `/resume` { requestId }
//
// Rules (the eval check's and the setup run's, and one stricter):
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, query, body or token claim. A script token never reaches this route.
//   - Anyone with no role on the project, another company's project, a missing one and a malformed name read the same 404. Any role on the project READS.
//   - EVERY change, and the decision, is a LIVE company OWNER or ADMIN: read now for the route's own check and read again inside the decision. The project's own administrator, who the setup run lets manage commands, may NOT.
//   - The audit record (naming the person and why) is written BEFORE the change: nothing changes when it cannot be written. Refusals are fixed words; nothing a caller sent is echoed; nothing is cached.
//   - The old admin route keeps refusing a named company's e2e registration (broker.ts); this family is the way a company's policy is written, and it writes only through the candidate flow (apply.ts).
import { AgentXError, agentXError, type AuditEvent, type AuditSink, type E2EReadyRuntimeProfile, type E2ESourceSnapshot, type ObjectStorage, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { GateResult } from "../core/decisions/approval-gate.js";
import { BROWSER_TESTING_WORDS } from "../core/setup-agent/browser-testing-state.js";
import {
  CheckBodySchema, ChoicesBodySchema, RefreshBodySchema, SimpleBodySchema, browserTestingView, checkDraft, discardCandidate, parseBody, refreshDraft, saveChoices, setPaused, waitingBrowserCandidate,
  type BrowserTestingDeps, type BrowserTestingView,
} from "../core/setup-agent/browser-testing.js";
import { SETUP_APPLY_KIND, waitingSetupApply } from "../core/setup-agent/apply.js";
import { setupHostApproverAllows } from "../core/setup-agent/setup-risk.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { setupCardOf, setupDecisionRequestId, type HostedSetupApproval } from "./setup-approval.js";
import type { SetupRunBasis, SetupRunStanding } from "./setup-run-routes.js";

export interface HostedBrowserTestingWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** The hosted approval of a setup candidate (the ONE gate, the approvers point's proof, the person's live standing). A browser testing candidate is decided through it. */
  approval: HostedSetupApproval;
  /** The company's object storage (the stored files and proposals). */
  objects: ObjectStorage;
  /** The repository at the head of its default branch, read through THIS company's own code host. */
  capture(companyId: OrgId, repository: { name: string; url: string; defaultBranch: string; host?: { kind: string } }): Promise<E2ESourceSnapshot>;
  /** The web and API runtime profiles READY for this project. */
  readyProfiles(companyId: OrgId, project: string): Promise<readonly E2EReadyRuntimeProfile[]>;
  /** Whether Rovara can start the sandbox for this project now (a ready runtime that passed every egress probe). */
  sandboxAvailable(companyId: OrgId, project: string): Promise<boolean>;
}

export interface HostedBrowserTestingInput {
  request: BrokerRequest; path: string; principal: TaskStartCaller["principal"]; companyId: OrgId; flow: TaskFlowDeps;
  wiring: HostedBrowserTestingWiring; audit: AuditSink; now: () => number;
}

const PATH = /^\/v1\/app\/projects\/([^/]+)\/browser-testing(?:\/(refresh|draft|check|decision|discard|pause|resume))?$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is the browser testing family's. */
export function isBrowserTestingPath(path: string, method: string): boolean {
  const match = PATH.exec(path);
  if (match === null) return false;
  const tail = match[2];
  if (tail === undefined) return method === "GET";
  return tail === "draft" ? method === "PUT" : method === "POST";
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", BROWSER_TESTING_WORDS.projectNotFound);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", BROWSER_TESTING_WORDS.unreadable);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", BROWSER_TESTING_WORDS.invalid); }
}

const DecisionBodySchema = z.object({
  requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u), outcome: z.enum(["approve", "reject"]),
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict();

/**
 * Whether a standing is a LIVE COMPANY owner or admin. This is the whole rule for every change here: the setup run's own `manage` also admits the project's administrator, and that is NOT enough for browser
 * testing (it lets the sandbox run candidate code with the company's budget), so it is never read as manage here.
 */
export const isCompanyAdminStanding = (standing: SetupRunStanding): standing is { access: "manage"; basis: "company-owner" | "company-admin" } =>
  standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin");

function gateRefusal(result: Extract<GateResult, { status: "refused" }>): AgentXError {
  switch (result.reason) {
    case "stale": case "not_waiting": case "not_found": case "link_gone": return agentXError("CHANGE_STALE", result.detail);
    case "expired": return agentXError("REAUTH_REQUIRED", result.detail);
    case "proof_already_used": case "request_id_reused": return agentXError("IDEMPOTENCY_CONFLICT", result.detail);
    case "invalid": case "unsupported": case "invalid_outcome": return agentXError("CONFIG_INVALID", result.detail);
    default: return agentXError("FORBIDDEN", result.detail);
  }
}

/** One request on the browser testing path (`isBrowserTestingPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedBrowserTesting(input: HostedBrowserTestingInput): Promise<BrokerResponse> {
  try {
    const match = PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!PROJECT_NAME.test(project)) throw notFound();
    const { flow, companyId, wiring } = input;
    const personId = input.principal.personId;
    let standing: SetupRunStanding;
    try { standing = await wiring.standing(personId, companyId, project); } catch { throw unavailable(); }
    // Anything but the two answers is no answer: read as none (never as manage).
    const manage = standing?.access === "manage";
    if (!manage && standing?.access !== "view") throw notFound();
    const adminBasis = isCompanyAdminStanding(standing) ? standing.basis : undefined;
    const admin = adminBasis !== undefined;
    const deps: BrowserTestingDeps = {
      flow, objects: wiring.objects, now: input.now,
      capture: (repository) => wiring.capture(companyId, repository),
      readyProfiles: (name) => wiring.readyProfiles(companyId, name),
      sandboxAvailable: (name) => wiring.sandboxAvailable(companyId, name),
    };
    const read = async (): Promise<BrowserTestingView> => browserTestingView(deps, {
      project, canManage: admin, personId, canDecide: admin, viewerRole: adminBasis !== undefined ? adminBasis.replace("company-", "") : manage ? "project-admin" : "member",
    });
    const action = match[2];
    if (input.request.method === "GET") return json(200, await read());
    if (!admin) throw agentXError("FORBIDDEN", BROWSER_TESTING_WORDS.notAllowed);
    const basis: SetupRunBasis = adminBasis;
    const raw = bodyOf(input.request);
    const record = async (name: string, requestId: string): Promise<void> => {
      const event: AuditEvent = {
        eventId: `browser_testing.${name}:${companyId}:${project}:${personId}:${requestId}`, companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: personId },
        action: `browser_testing.${name}`, subject: { type: "project", id: project }, details: { project, basis, requestId },
      };
      try { await input.audit.record(event); } catch { throw agentXError("AUDIT_UNAVAILABLE", BROWSER_TESTING_WORDS.auditUnavailable); }
    };
    if (action === "decision") return json(200, { ...(await decide(input, deps, project, parseBody(DecisionBodySchema, raw))), view: await read() });
    await applyChange(deps, { personId, project, action, raw, record });
    return json(200, await read());
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(unavailable());
  }
}

/** One of the changes that is not the decision: the audit record first, then the change. */
async function applyChange(deps: BrowserTestingDeps, input: { personId: string; project: string; action: string | undefined; raw: unknown; record: (name: string, requestId: string) => Promise<void> }): Promise<void> {
  const { personId, project, raw, record } = input;
  switch (input.action) {
    case "refresh": { const body = parseBody(RefreshBodySchema, raw); await record("refresh", body.requestId); return await refreshDraft(deps, project, personId, body); }
    case "draft": { const body = parseBody(ChoicesBodySchema, raw); await record("choices", body.requestId); return await saveChoices(deps, project, personId, body); }
    case "check": { const body = parseBody(CheckBodySchema, raw); await record("check", body.requestId); return await checkDraft(deps, project, personId, body); }
    case "discard": { const body = parseBody(SimpleBodySchema, raw); await record("discard", body.requestId); return await discardCandidate(deps, project, personId); }
    case "pause": case "resume": { const body = parseBody(SimpleBodySchema, raw); await record(input.action, body.requestId); return await setPaused(deps, project, personId, input.action === "pause", body.requestId); }
    default: throw agentXError("NOT_FOUND", "route not found");
  }
}

/** Approve or reject the waiting browser testing change: the live owner or admin rule, the approvers point's proof of this act, then the gate (which loads the candidate again and re-checks the rule). */
async function decide(input: HostedBrowserTestingInput, deps: BrowserTestingDeps, project: string, body: z.infer<typeof DecisionBodySchema>): Promise<Record<string, unknown>> {
  const { flow, companyId, wiring } = input;
  const personId = input.principal.personId;
  const waiting = await waitingBrowserCandidate(deps, project);
  if (waiting !== undefined) {
    // What the person saw is what is waiting: the digest and revision, and the id the page was offered for them.
    if (body.seen.artifactDigest !== waiting.digest || body.seen.revision !== waiting.candidateRevision || body.requestId !== setupDecisionRequestId(waiting.digest, waiting.candidateRevision)) throw agentXError("CHANGE_STALE", BROWSER_TESTING_WORDS.stale);
  } else if ((await waitingSetupApply(flow.store, companyId, project)) !== undefined) {
    // A change of another kind waits: it is not this page's to decide.
    throw agentXError("CHANGE_STALE", BROWSER_TESTING_WORDS.nothingWaiting);
  }
  // With nothing waiting the gate still answers a repeat of a decision already made (it keeps the record under the request id), and refuses anything else.
  let who: Awaited<ReturnType<HostedSetupApproval["standing"]>>;
  try { who = await wiring.approval.standing(personId, project); } catch { throw unavailable(); }
  if (!setupHostApproverAllows(who)) throw agentXError("FORBIDDEN", BROWSER_TESTING_WORDS.adminOnly);
  const card = setupCardOf(project, body.seen.artifactDigest);
  let credential: { method: string; token: string };
  try {
    credential = await wiring.approval.issue({ companyId, personId, requestId: body.requestId, kind: "setup", project, revision: body.seen.revision, artifactDigest: body.seen.artifactDigest, outcome: body.outcome, card });
  } catch { throw agentXError("FORBIDDEN", BROWSER_TESTING_WORDS.noProof); }
  const result = await wiring.approval.gate.decide({
    companyId, kind: SETUP_APPLY_KIND, subjectId: project, requestId: body.requestId, outcome: body.outcome, seen: body.seen,
    credentials: [{ method: credential.method, token: credential.token }], card,
  });
  if (result.status === "refused") throw gateRefusal(result);
  void flow;
  return { project, decision: body.outcome === "approve" ? "approved" : "rejected", revision: result.record.revision, replayed: result.status === "replayed" };
}
