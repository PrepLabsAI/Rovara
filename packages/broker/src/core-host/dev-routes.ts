// Engine host (lane E2): the core's own handlers, mountable on the deployed developer API behind the switch (`ROVARA_CORE_ENGINE`, default off).
//
// The controller decided that, once the host is deployed, these answers come from the core itself, not from adapters on the old broker:
//   - sessions (`/v1/app/sessions...`): a session's read (the task view with its evidence), the understanding answers (`POST .../answers`), stop, retry, follow;
//   - a task's read (`GET /v1/dev/tasks/<id>`), whose view carries the evidence kept for its checked code;
//   - a task's START (`POST /v1/dev/tasks`), only for a member whose company the switch sends NEW tasks to the core (`engineForNewTask`). Anyone else, and a person with no member company,
//     gets `undefined`: the old broker starts the task exactly as before (lane E2 step 6). A membership read that fails refuses (the sign-in refusal), never falls back;
//   - decision cards (`/v1/app/decisions`): the list, through the deployment's sources (each checks the caller's live authority). Acting on a card (approve, reject, request changes,
//     evidence-opened) needs a FRESH STEP-UP (lane ID part 2): the person proved it was them with a factor Code owns (an emailed code, a passkey, or a company sign-in's own
//     re-authentication), no longer ago than the company's window. A Slack, Google or GitHub round trip never counts, and a tool holding an ordinary API token has no step-up;
//   - the owner's moves on a task already running (DECISIONS 198): `POST /v1/dev/tasks/<id>/workflow/send-back`, `.../workflow/review-findings` and `.../continue`, with the
//     old workflow routes' request and answer (`{ task }`), so Cloud's Send back and Accept findings work for a task of either engine. Served only when the deployment wires the money
//     cap per round (`taskActions.roundCap`) AND the company's owner rule (`TaskAccess.ownerActing` on the runtime's access): without that seam the flow would use Code's laptop rule
//     (the install's owner role), which a hosted company never uses for who owns a task;
//   - how we work (`GET /v1/app/projects/<p>/how-we-work`, `.../playbook`): read only, for a person the company lets read that project;
//   - the setup run (`/v1/app/projects/<p>/setup-agent...`, guided onboarding L2-3): start, re-run, stop and the journal (confirm and discard stay the laptop's until a hosted approval exists), for a live company owner or admin or the
//     project's administrator (a project user reads it); the rules are setup-run-routes.ts's;
//   - script tokens (`/v1/app/script-tokens...`): list and revoke; MAKING one needs a fresh step-up as above (controller decision, option A of R2-SCRIPT-TOKEN-CREDENTIAL: the laptop's
//     "a page signed in to a few minutes ago" rule, with Code's own factor as the proof). A token's own requests are not accepted here either (the broker's sign-in decides that).
//   - The step-up's time comes only from the caller the broker's sign-in vouched for (`DeployedCaller.stepUp`, read from the verified access token), never from a header, a query or a
//     body. The age is checked HERE, on every such request, against the company's window (`stepUpWindowSeconds`, the policy hook's answer, which may only shorten the default), so a
//     token whose step-up is older than the window is refused whatever the calling service says.
//
// Rules:
//   - Off (the default) is byte-identical: `route` answers `undefined` for every request without reading anything, and the old broker answers as before.
//   - A path this module does not own is `undefined` too; `/v1/local/*` (the laptop's page routes) is never served.
//   - The caller's company comes from MEMBERSHIP (`companyOf`, R4's reader), never from a header, a query, a body or a token claim. A reader that throws or answers nothing refuses the
//     call with the sign-in refusal; there is no fallback to the install's company.
//   - A company the switch does not send to the core, and that holds no core task, is the old broker's (`undefined`).
//   - A handler the deployment has not wired answers a fixed "not on the core yet" (never a laptop default: the session levels, decision authority and the playbook's code host are the
//     deployment's).
import { APPROVAL_SIGN_IN_SKEW_SECONDS, AgentXError, FRESH_SIGN_IN_SECONDS, OrgRoleSchema, agentXError, checkApprovalSignIn, type AuditSink, type ObjectStorage, type OrgRole, type Principal } from "@agentx/contracts";
import type { TaskCaller } from "../core/task-flow/deps.js";
import { loadOwnedTask, taskViewOf } from "../core/task-flow/reads.js";
import type { TaskActionsOptions } from "../core/task-flow/owner-round.js";
import { createTaskActions, type TaskActions } from "../core/task-flow/task-actions.js";
import { stopTaskOnRequest } from "../core/task-flow/stop-request.js";
import { routeDecisionCards, type DecisionCaller, type DecisionRouteDependencies } from "../core/decisions/routes.js";
import type { SessionMembers } from "../core/sessions/access.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { PlaybookService } from "../core/playbook/service.js";
import { createScriptToken, listScriptTokens, revokeScriptToken, scriptTokensEnabled, STEP_UP_METHODS, type ScriptTokenCaller, type ScriptTokenSignIn } from "../core/script-tokens/index.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { createSessionRoutes } from "../local/app/session-routes.js";
import { createLocalPlaybook } from "../local/app/playbook.js";
import { developerTaskView } from "../local/app/task-view.js";
import type { CoreHostApp } from "./app.js";
import type { CoreRuntime } from "./core-runtime.js";
import { AGENT_MODELS_PATH, agentModelRoute } from "./agent-model-routes.js";
import type { AgentModelChoice } from "./gateway-model-selection.js";
import { isSetupRunPath, routeHostedSetupRun, type HostedSetupRunWiring } from "./setup-run-routes.js";
import { isWikiMapPath, routeHostedWikiMap, type HostedWikiMapWiring } from "./wiki-map-routes.js";
import { isWikiPath, routeHostedWiki, type HostedWikiWiring } from "./wiki-routes.js";
import { isWikiBuildPath, routeHostedWikiBuild, type HostedWikiBuildWiring } from "./wiki-build-routes.js";

/** The paths this module owns. Anything else is the old broker's. */
const SESSIONS = /^\/v1\/app\/sessions(?:\/|$)/u;
const TASK_READ = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})$/u;
/** The owner's moves on a task already running (DECISIONS 198), on the old workflow routes' paths. */
const TASK_ACTION = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/(workflow\/send-back|workflow\/review-findings|continue)$/u;
/** A person's Stop on a core task, on the old cancel route's path (`{ requestId }` in, `{ task }` out), so Cloud's Stop and the AI tools' cancel stop a task of either engine. */
const TASK_CANCEL = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/cancel$/u;
const TASK_START = "/v1/dev/tasks";
const DECISIONS = /^\/v1\/app\/decisions(?:\/|$)/u;
const PLAYBOOK = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/(?:how-we-work|playbook)$/u;
const SCRIPT_TOKENS = /^\/v1\/app\/script-tokens(?:\/([^/]+)\/revoke)?$/u;

export const NOT_ON_THE_CORE_YET = "That is not on the core engine on this install yet.";
export const MAKE_SCRIPT_TOKEN_ON_A_PAGE = "A script token is made right after you confirm it's you on the sign-in page: it is a long-lived credential, so a tool that holds an API token cannot make one. Confirm it's you, then try again within a few minutes.";
export const SIGN_IN_AGAIN = "Sign in again.";
export const DECIDE_ON_A_PAGE = "A decision is made right after you confirm it's you on the sign-in page: a tool that holds an API token cannot approve or reject. Confirm it's you, then try again within a few minutes.";
export const COMPANY_RULES_NO_ANSWER = "The company rules service did not answer, so nothing was done. Try again in a moment.";
export const NOT_FOR_SCRIPT_TOKENS = "A script token cannot do that.";
export const SESSION_CAP_UNREADABLE = "This install's session limit could not be read, so no token was made. Try again later, or ask whoever runs the install.";
const PROJECT_NOT_FOUND = "project not found";

/** The deployed caller, as the broker's sign-in vouches for it. */
export interface DeployedCaller {
  principal: Principal;
  client?: string | undefined;
  /** Set by the broker's sign-in when the request carries a script token (never from a body). Such a caller reaches only a task's read here. */
  scriptToken?: { tokenId: string } | undefined;
  /**
   * Lane ID part 2: the person's last step-up as the VERIFIED access token states it (`stepUpOf` over its `step_up_at` and `step_up_amr`), set by the broker's sign-in and never from a
   * header, a query or a body. `at` is an ISO time. Absent: no step-up in this session. The age is checked on the route, never trusted from it.
   */
  stepUp?: { at: string; method: string } | undefined;
}

/** A decision card's caller on the deployed API: who acts and, for the deployment's performer, the person with the step-up time as `Principal.authTime`. */
export interface DeployedDecisionCaller extends DecisionCaller {
  principal: Principal;
  /** Present on an act (approve, reject, request changes, evidence-opened): the fresh step-up the route checked. Absent on a read. */
  stepUp?: { at: string; method: string };
}

/** What membership says about the caller: the company and the live role in it (never a token claim). */
export interface CompanyMembership {
  companyId: string;
  role: OrgRole;
}

/** What the deployment wires for one company. Each part is optional; a missing one answers `NOT_ON_THE_CORE_YET`. */
export interface CoreDevWiring {
  /** The session levels from the company's own records (lanes ID and T). Without it the session routes are not served (the laptop's default is the sole owner). */
  members?: SessionMembers;
  /** The decision cards' sources and performer (each checks the caller's live authority). An act reaches the performer only after the route checked a fresh step-up. */
  decisions?: DecisionRouteDependencies<DeployedDecisionCaller>;
  /**
   * The company's step-up window in seconds, through the policy hook. It may only shorten FRESH_SIGN_IN_SECONDS (ten minutes, the sign-in server's DEVELOPER_STEP_UP_WINDOW_SECONDS). Absent: that default. A throw, or an answer that is not a whole
   * number from 0 to 86400, is no answer: the act is refused (`COMPANY_RULES_NO_ANSWER`), never let through on the default.
   */
  stepUpWindowSeconds?: () => Promise<unknown>;
  /**
   * The owner's moves on a task already running (send back, review findings, continue; DECISIONS 198). `roundCap` is the money cap each round is held to (the task's limit and what it has
   * spent; a throw, or an unreadable spend, refuses the round). It is required so the deployment says what it holds; `async () => undefined` holds none. Served only when the runtime's
   * `TaskAccess.ownerActing` (the company's owner and co-owner rule) is wired too; otherwise these routes are not the core's yet here.
   */
  taskActions?: { roundCap: NonNullable<TaskActionsOptions["roundCap"]> };
  /** How we work, read through the company's code host. Served only with `canReadProject`. */
  playbook?: PlaybookService;
  /** Whether this person may read this project (their project grant from the company's own records). A project they may not read answers exactly like a missing one. */
  canReadProject?: (personId: string, project: string) => Promise<boolean>;
  /** Script tokens' list and revoke (the token store is the core's; the audit sink is the registry's). */
  scriptTokens?: { enabled?: () => boolean };
  /**
   * ID-STEPUP-FOLLOWUPS (d): the install's session cap in seconds, where it caps every session: a script token made here lives no longer than a session would. Absent: no cap (the days
   * asked for). Anything but a positive whole number makes no token (fixed words), never one without the cap.
   */
  sessionCapSeconds?: number;
  /** The company's agent model choice over the gateway's offered models (`createAgentModelChoice`). Absent: `/v1/app/agent-models` says "not on the core yet". */
  modelChoice?: AgentModelChoice;
  /** The URL clients reach the API at (a session's `link`). */
  origin: () => string;
  /** Hosted wiring (d): the audit sink for one request, naming the caller it came through (`auditSinkForDeployedCaller`). Absent: the registry's sink as it is. */
  auditFor?: (caller: DeployedCaller, sink: AuditSink) => AuditSink;
  /** Guided onboarding L2-3: the hosted setup run (`/v1/app/projects/<p>/setup-agent...`, setup-run-routes.ts). Absent: those paths say "not on the core yet". */
  setupRun?: HostedSetupRunWiring;
  /** Wiki W0: the free file map (`/v1/app/projects/<p>/wiki-map`, wiki-map-routes.ts). Absent: that path says "not on the core yet". */
  wikiMap?: HostedWikiMapWiring;
  /** Lead 4 W2: the project wiki's reads (`/v1/app/projects/<p>/wiki...`, wiki-routes.ts). Absent: those paths say "not on the core yet". */
  wiki?: HostedWikiWiring;
  /** Lead 4 W4: the wiki build controls (`/v1/app/projects/<p>/wiki-build...`, wiki-build-routes.ts). Absent: those paths say "not on the core yet". */
  wikiBuild?: HostedWikiBuildWiring;
}

export interface CoreDevRoutesOptions {
  app: CoreHostApp;
  /** The caller's company and live role from membership, never a claim. Undefined: not a member (refused). */
  companyOf(caller: DeployedCaller): Promise<CompanyMembership | undefined>;
  /** The company's wiring, built once per company (a build that fails is tried again on the next request, as the runtime is). */
  wiring(runtime: CoreRuntime): CoreDevWiring | Promise<CoreDevWiring>;
  log?: (entry: Record<string, unknown>) => void;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const ORG_ID = /^org_[0-9a-z]{20}$/u;
/** A token id from the path; a malformed escape is a token that does not exist. */
function tokenIdOf(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw agentXError("NOT_FOUND", "route not found"); }
}

/** Only the methods the core's handlers serve: anything else under these paths stays the old broker's (a playbook PUT is its editor's). */
function owns(path: string, method: string): boolean {
  if (path === TASK_START) return method === "POST";
  if (TASK_READ.test(path) || PLAYBOOK.test(path)) return method === "GET";
  if (TASK_ACTION.test(path) || TASK_CANCEL.test(path)) return method === "POST";
  if (path === AGENT_MODELS_PATH) return method === "GET" || method === "POST";
  if (isSetupRunPath(path, method) || isWikiMapPath(path, method)) return true;
  if (isWikiPath(path, method) || isWikiBuildPath(path, method)) return true;
  return SESSIONS.test(path) || DECISIONS.test(path) || SCRIPT_TOKENS.test(path);
}
const unauthenticated = (): BrokerResponse => json(401, { error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });

/** A request body as JSON, whatever its shape (the caller's schema judges it); text that is not JSON is a fixed refusal. */
function jsonBodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

/** A request body as one JSON object; anything else is a fixed refusal (no echo of what was sent). */
function bodyOf(request: BrokerRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === "") return {};
  let value: unknown;
  try { value = JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the request body must be an object");
  return value as Record<string, unknown>;
}

/** The factors Code owns (the sign-in server's DEVELOPER_STEP_UP_METHODS). A Slack, Google or GitHub round trip is none of them, whatever a wiring maps into the caller. */
const STEP_UP_FACTORS: ReadonlySet<unknown> = new Set<unknown>(STEP_UP_METHODS);
/** The one time form the broker's sign-in writes (`toISOString`); a looser string that Date.parse would still read is refused. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * Lane ID part 2: the caller's step-up, if it is fresh enough for this company now; otherwise the refusal. The window is the company's (through the hook) and may only be shorter than
 * the default; a missing, unreadable, too-old or future step-up time is refused (`checkApprovalSignIn`'s window rule, with its clock-skew allowance).
 */
async function freshStepUp(caller: DeployedCaller, wiring: CoreDevWiring, nowMs: number, refusal: string): Promise<{ at: string; method: ScriptTokenSignIn["amr"] }> {
  // The step-up is read first: a caller without one is refused without asking the company rules service.
  const stepUp = caller.stepUp;
  if (stepUp === undefined || stepUp === null || typeof stepUp !== "object" || typeof stepUp.at !== "string" || !ISO_INSTANT.test(stepUp.at) || !STEP_UP_FACTORS.has(stepUp.method)) throw agentXError("REAUTH_REQUIRED", refusal);
  let seconds = FRESH_SIGN_IN_SECONDS;
  if (wiring.stepUpWindowSeconds !== undefined) {
    let answer: unknown;
    try { answer = await wiring.stepUpWindowSeconds(); } catch { answer = undefined; }
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer > 86_400) throw agentXError("RUNTIME_UNAVAILABLE", COMPANY_RULES_NO_ANSWER);
    seconds = Math.min(seconds, answer);
  }
  // A zero window refuses every step-up; checkApprovalSignIn's window needs at least a minute, so it is decided here.
  if (seconds === 0) throw agentXError("REAUTH_REQUIRED", refusal);
  const verdict = checkApprovalSignIn({ mode: "window", seconds: Math.max(seconds, 60) }, { authTime: stepUp.at }, nowMs, { companySignIn: false });
  if (!verdict.ok) throw agentXError("REAUTH_REQUIRED", refusal);
  // Below a minute, checkApprovalSignIn's floor would be looser than the company asked: the exact age is checked too, and the clock-skew allowance never exceeds the window.
  const age = nowMs - Date.parse(stepUp.at);
  if (age > seconds * 1000 || -age > Math.min(APPROVAL_SIGN_IN_SKEW_SECONDS, seconds) * 1000) throw agentXError("REAUTH_REQUIRED", refusal);
  return { at: stepUp.at, method: stepUp.method as ScriptTokenSignIn["amr"] };
}

const nowOf = (target: Mounted): number => (target.runtime.flow.deps.now?.() ?? new Date()).getTime();

interface Mounted {
  runtime: CoreRuntime;
  blobs: ObjectStorage;
  wiring: CoreDevWiring;
  sessions?: ReturnType<typeof createSessionRoutes>;
  playbook?: ReturnType<typeof createLocalPlaybook>;
  actions?: TaskActions;
}

export function createCoreDevRoutes(options: CoreDevRoutesOptions): { route(request: BrokerRequest, caller: DeployedCaller): Promise<BrokerResponse | undefined> } {
  const mounted = new Map<string, Promise<Mounted>>();
  const mount = (companyId: string): Promise<Mounted> => {
    let found = mounted.get(companyId);
    if (found === undefined) {
      found = options.app.runtimeFor(companyId).then(async (runtime) => {
        const wiring = await options.wiring(runtime);
        const blobs = (await options.app.registry()).require("object-storage");
        return {
          runtime, wiring, blobs,
          ...(wiring.members === undefined ? {} : { sessions: createSessionRoutes({ flow: runtime.flow, blobs, companyId: runtime.companyId, origin: wiring.origin, members: wiring.members }) }),
          ...(wiring.playbook === undefined ? {} : { playbook: createLocalPlaybook({ playbook: wiring.playbook, store: runtime.flow.deps.store, companyId: runtime.companyId }) }),
          // The owner's moves need both the money cap and the company's owner rule; with either missing they are not served (never Code's laptop owner rule on a hosted company).
          ...(wiring.taskActions === undefined || runtime.flow.deps.access.ownerActing === undefined ? {} : { actions: createTaskActions(runtime.flow.deps, { roundCap: wiring.taskActions.roundCap }) }),
        };
      });
      found.catch(() => mounted.delete(companyId));
      mounted.set(companyId, found);
    }
    return found;
  };

  return {
    async route(request, caller) {
      // Off: nothing is read and nothing answers here.
      if (!options.app.serving) return undefined;
      const path = request.path.split("?")[0] ?? request.path;
      if (!owns(path, request.method)) return undefined;
      const starting = path === TASK_START;
      let membership: CompanyMembership | undefined;
      let unreadable = false;
      try {
        membership = await options.companyOf(caller);
      } catch {
        membership = undefined;
        unreadable = true;
      }
      // A start by a person with no member company is no core company's: the old broker starts it, as before. (Every other route refuses below.)
      if (starting && !unreadable && (membership === undefined || membership === null)) return undefined;
      // Fail closed: no member company, a malformed one or an unknown role is a sign-in refusal, never the install's company.
      if (membership === undefined || membership === null || typeof membership !== "object" || typeof membership.companyId !== "string" || !ORG_ID.test(membership.companyId) || !OrgRoleSchema.safeParse(membership.role).success) return unauthenticated();
      const companyId = membership.companyId;
      // The principal the identity point vouched for must be of the member company (checked before anything is built for it); the task flow checks it again on every task read.
      if (caller.principal.companyId !== companyId) return unauthenticated();
      // A start goes to the core only where the switch sends this company's NEW tasks there; anywhere else the old broker starts it (nothing is read or built here).
      if (starting && options.app.engineForNewTask(companyId) !== "core") return undefined;
      // A script token reaches only a task's read here (its closed list: its own projects' tasks); never sessions, decisions, playbooks or tokens.
      // An owner's move on a task is never a script token's, and its answer must not tell a token which task ids exist: it reads like a missing task (the boundary's own answer).
      if (caller.scriptToken !== undefined && (TASK_ACTION.test(path) || TASK_CANCEL.test(path))) return errorAnswer(agentXError("NOT_FOUND", "route not found"));
      if (caller.scriptToken !== undefined && !TASK_READ.test(path)) return errorAnswer(agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS));
      let target: Mounted;
      try {
        target = await mount(companyId);
      } catch (error) {
        // A company the switch does not send to the core and that holds no core task stays on the old broker.
        if (error instanceof Error && error.name === "CoreEngineOffError") return undefined;
        throw error;
      }
      const taskCaller: TaskCaller = { principal: caller.principal, ...(caller.client === undefined ? {} : { client: caller.client }) };
      try {
        if (SESSIONS.test(path)) {
          if (target.sessions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return (await target.sessions(request, taskCaller)) ?? errorAnswer(agentXError("NOT_FOUND", "route not found"));
        }
        if (starting) {
          // The core's own start (it parses the request, checks the person may start on the project, holds the admission and writes the engine stamp in one transaction). A retry with the
          // same request id answers the first task. The answer is the developer task view, as the old start's.
          const started = await target.runtime.flow.start({ ...taskCaller, origin: caller.client === undefined ? "cli" : "app" }, bodyOf(request));
          const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, started.task.taskId);
          return json(200, { task: await developerTaskView(record, await taskViewOf(target.runtime.flow.deps, record), target.blobs) });
        }
        const task = TASK_READ.exec(path);
        if (task !== null) {
          if (request.method !== "GET") return undefined;
          // Another company's task, or none, answers the same "not found" (the flow's owned read checks the company).
          const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, task[1]!);
          return json(200, { task: await developerTaskView(record, await taskViewOf(target.runtime.flow.deps, record), target.blobs) });
        }
        const cancel = TASK_CANCEL.exec(path);
        if (cancel !== null) {
          // Served only with the company's owner rule (never Code's laptop rule on a hosted company); without it the engine boundary says "not on the core yet" to a reader, and a missing task to anyone else.
          if (target.runtime.flow.deps.access.ownerActing === undefined) return undefined;
          // The task's owner, or a live owner or admin of the task's company (the role is membership's, read for this request; the task's company is checked against it). Anyone who may not
          // read the task gets the missing task's answer whatever they sent; a reader who may not stop gets fixed words. One request id is one stop.
          const stopped = await stopTaskOnRequest(target.runtime.flow.deps, { ...taskCaller, companyRole: membership.role }, cancel[1]!, () => jsonBodyOf(request));
          return json(200, { task: await developerTaskView(stopped.task, await taskViewOf(target.runtime.flow.deps, stopped.task), target.blobs) });
        }
        const action = TASK_ACTION.exec(path);
        if (action !== null) {
          // Not wired here: the caller of these routes (the engine boundary) tells a person who may read the task that it is not on the core yet, and anyone else that there is no such task.
          if (target.actions === undefined) return undefined;
          const taskId = action[1]!;
          // The task is read first, so someone who may not see it reads "no such task" whatever they sent (a body the move refuses would otherwise tell them the task exists).
          await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
          // The body as JSON, judged by the move's own schema (its words name the field), as the old workflow routes do.
          const body = jsonBodyOf(request);
          // Each move re-checks who acts (owner or co-owner, else "no such task"), the revision they saw, and the round's money, and writes nothing on a refusal.
          if (action[2] === "workflow/send-back") await target.actions.sendBack(taskCaller, taskId, body);
          else if (action[2] === "workflow/review-findings") await target.actions.resolveFindings(taskCaller, taskId, body, "api-token");
          else await target.actions.continue(taskCaller, taskId, body);
          const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
          return json(200, { task: await developerTaskView(record, await taskViewOf(target.runtime.flow.deps, record), target.blobs) });
        }
        if (DECISIONS.test(path)) {
          if (target.wiring.decisions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          // Reading the cards needs no step-up; approve, reject, request changes and evidence-opened need a fresh one, checked here before anything else is read.
          const stepUp = request.method === "GET" ? undefined : await freshStepUp(caller, target.wiring, nowOf(target), DECIDE_ON_A_PAGE);
          const body = request.method === "GET" ? {} : bodyOf(request);
          const url = new URL(request.path, "http://core");
          // The step-up time is the person's fresh sign-in for the performer's own rules (`Principal.authTime`); on a read nothing is decided and the principal carries no sign-in time.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop them
          const { authTime: _ignored, methods: _alsoIgnored, ...person } = caller.principal;
          const decisionCaller: DeployedDecisionCaller = {
            orgId: companyId, developerId: developerIdOf(caller.principal),
            principal: stepUp === undefined ? person : { ...person, authTime: stepUp.at, methods: [stepUp.method] },
            ...(stepUp === undefined ? {} : { stepUp }),
          };
          const reply = await routeDecisionCards(target.wiring.decisions, decisionCaller, { method: request.method, pathname: path, searchParams: url.searchParams, body });
          if (reply === undefined) throw agentXError("NOT_FOUND", "route not found");
          return json(reply.statusCode, reply.body);
        }
        if (path === AGENT_MODELS_PATH) {
          if (target.wiring.modelChoice === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await agentModelRoute({
            method: request.method, body: request.body, principal: caller.principal, role: membership.role, choice: target.wiring.modelChoice,
            audit: target.wiring.auditFor === undefined ? undefined : target.wiring.auditFor(caller, target.runtime.flow.deps.audit),
            freshStepUp: (refusal) => freshStepUp(caller, target.wiring, nowOf(target), refusal),
          });
        }
        if (isSetupRunPath(path, request.method)) {
          // Guided onboarding L2-3: the company's own runtime, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.setupRun === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedSetupRun({
            request, path, principal: caller.principal, client: caller.client, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.setupRun,
            audit: target.wiring.auditFor === undefined ? target.runtime.flow.deps.audit : target.wiring.auditFor(caller, target.runtime.flow.deps.audit),
            startsNewTasks: options.app.engineForNewTask(companyId) === "core", now: () => nowOf(target),
          });
        }
        if (isWikiMapPath(path, request.method)) {
          // Wiki W0: the company's own runtime, the caller's live standing on the project (read inside), the company's code host.
          if (target.wiring.wikiMap === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWikiMap({ request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.wikiMap, now: () => nowOf(target), log: options.log });
        }
        if (isWikiPath(path, request.method)) {
          // Lead 4 W2: the member company's own store; the caller's live standing on the project is read inside (any project role reads).
          if (target.wiring.wiki === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWiki({ request, path, personId: caller.principal.personId, companyId: target.runtime.companyId, store: target.runtime.flow.deps.store, wiring: target.wiring.wiki, now: () => nowOf(target) });
        }
        if (isWikiBuildPath(path, request.method)) {
          // Lead 4 W4: the company's own runtime, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.wikiBuild === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWikiBuild({
            request, path, principal: caller.principal, client: caller.client, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.wikiBuild,
            audit: target.wiring.auditFor === undefined ? target.runtime.flow.deps.audit : target.wiring.auditFor(caller, target.runtime.flow.deps.audit),
            startsNewTasks: options.app.engineForNewTask(companyId) === "core", now: () => nowOf(target), log: options.log,
          });
        }
        const playbook = PLAYBOOK.exec(path);
        if (playbook !== null) {
          if (target.playbook === undefined || target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          // A project the person may not read, and one that does not exist, answer the same words.
          if (!(await target.wiring.canReadProject(caller.principal.personId, playbook[1]!).catch(() => false))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          const answer = (await target.playbook.routes(request)) ?? errorAnswer(agentXError("NOT_FOUND", PROJECT_NOT_FOUND));
          return answer.statusCode === 404 ? errorAnswer(agentXError("NOT_FOUND", PROJECT_NOT_FOUND)) : answer;
        }
        const tokens = SCRIPT_TOKENS.exec(path);
        if (tokens !== null) {
          const enabled = target.wiring.scriptTokens?.enabled ?? (() => scriptTokensEnabled());
          if (target.wiring.scriptTokens === undefined || !enabled()) throw agentXError("NOT_FOUND", "route not found");
          const audit = target.wiring.auditFor === undefined ? target.runtime.flow.deps.audit : target.wiring.auditFor(caller, target.runtime.flow.deps.audit);
          const deps = { store: target.runtime.flow.deps.store, audit, now: () => nowOf(target) };
          // The live role from membership decides whether the list and revoke reach every token of the company (an administrator) or only the caller's own.
          const scriptCaller: ScriptTokenCaller = { developerId: developerIdOf(caller.principal), personId: caller.principal.personId, orgId: companyId, orgRole: membership.role };
          if (tokens[1] === undefined && request.method === "POST") {
            // Making a token needs a fresh step-up, checked before the body is read.
            const stepUp = await freshStepUp(caller, target.wiring, nowOf(target), MAKE_SCRIPT_TOKEN_ON_A_PAGE);
            const canRead = target.wiring.canReadProject;
            if (canRead === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
            const cap = target.wiring.sessionCapSeconds;
            if (cap !== undefined && (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)) throw agentXError("RUNTIME_UNAVAILABLE", SESSION_CAP_UNREADABLE);
            // A token is made only for projects this person may read now; one they may not read answers exactly like a missing one.
            // The record keeps how the maker proved it was them (the step-up's factor as its amr, and its time), and the token never outlives the install's session cap.
            const made = await createScriptToken(deps, scriptCaller, bodyOf(request), async (project) => {
              if (!(await canRead(caller.principal.personId, project).catch(() => false))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
            }, { ...(cap === undefined ? {} : { lifetimeCapSeconds: cap }), signIn: { amr: stepUp.method, authTime: stepUp.at } });
            return json(201, made);
          }
          if (tokens[1] === undefined && request.method === "GET") return json(200, { tokens: await listScriptTokens(deps, scriptCaller, async (developerId) => (developerId === scriptCaller.developerId ? caller.principal.displayName : undefined)) });
          if (tokens[1] !== undefined && request.method === "POST") return json(200, { token: await revokeScriptToken(deps, scriptCaller, tokenIdOf(tokens[1])) });
          throw agentXError("NOT_FOUND", "route not found");
        }
        return undefined;
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        throw error;
      }
    },
  };
}
