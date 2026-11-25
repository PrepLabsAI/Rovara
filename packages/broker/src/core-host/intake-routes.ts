// R1 + L1 6.2b (plan 4.3): a project's waiting tickets on the hosted core, at the ONE address the laptop, the MCP tools and the CLI already use, served AS the signed-in person:
//
//   GET  /v1/app/projects/{project}/intake                    { items, sources: [] } (`IntakeWaitingListSchema`); each row also says, for THIS person, `canStart`, `canDismiss` and `reasonWords`
//   POST /v1/app/projects/{project}/intake/{itemId}/start     { requestId }  "Start": the work is the presser's ({ started: true, taskId, sessionId? } or { started: false, reason | state })
//   POST /v1/app/projects/{project}/intake/{itemId}/dismiss   { requestId }  "Not this one": { dismissed: true }
//
// (It replaces the hosted-only `/v1/dev/projects/{project}/intake*` rows: one address in Code.) Code holds every role rule; a screen only renders the answer.
//   - The company is the caller's LIVE membership (the dev routes' company), never a body, query, header or token claim. The person's standing on the project is the setup run's own live read.
//   - A project that is not this company's (another company's, a missing one, a bad name), and a person with no role on it, get the same 404 "project not found". A project member who is not its admin gets the fixed 403.
//   - A company owner or admin, or the project's administrator, sees the list and may dismiss. `canStart` is true only when that person ALSO holds the right to start work on the project (the engine's `mayStart`, then the
//     start's own check): a company admin with no grant on the project sees and dismisses, and gets the fixed 403 on Start. The work is the presser's: they start it, they pay.
//   - A ticket id that is not this project's waiting ticket (another project's, another company's, started, unknown) is one 404. Fixed words throughout, never the request's own.
import { AgentXError, INTAKE_WAIT_REASON_WORDS, IntakeDismissBodySchema, IntakeStartBodySchema, WikiProjectSchema, agentXError, type IntakeWaitingList, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import type { SetupRunStanding } from "./setup-run-routes.js";

/** What the routes need of the company's hosted intake (aws/hosted-intake.ts `HostedIntake` is this). */
export interface HostedIntakeApp {
  waiting(companyId: OrgId, project: string): Promise<IntakeWaitingList>;
  mayStart(companyId: OrgId, project: string, personId: string): Promise<boolean>;
  start(companyId: OrgId, project: string, itemId: string, personId: string): Promise<
    { outcome: "started"; taskId: string; sessionId?: string | undefined } | { outcome: "waiting"; reason: string } | { outcome: "duplicate"; state: string } | { outcome: "not_found" } | { outcome: "forbidden" }>;
  dismiss(companyId: OrgId, project: string, itemId: string, personId: string): Promise<boolean>;
}

export interface HostedIntakeAppWiring {
  /** The person's standing on the project in THIS company, read live. Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** The company's hosted intake, or undefined while it is not built (the routes then answer as not on the core). */
  intake(): HostedIntakeApp | undefined;
}

export const INTAKE_WORDS = {
  projectNotFound: "project not found",
  adminOnly: "Only a company owner or admin, or the project's admin, can see and act on its waiting tickets.",
  noTicket: "no such waiting ticket",
  cannotStart: "You can't start work on this project.",
  unavailable: "The waiting tickets could not be read just now; try again.",
  badBody: "this takes { requestId }",
} as const;

const LIST_PATH = /^\/v1\/app\/projects\/([^/]+)\/intake$/u;
const ACT_PATH = /^\/v1\/app\/projects\/([^/]+)\/intake\/([^/]+)\/(start|dismiss)$/u;
const ITEM_ID = /^[a-f0-9]{32}$/u;

/** Whether this method and path is a waiting-ticket route. */
export function isIntakePath(path: string, method: string): boolean {
  return (method === "GET" && LIST_PATH.test(path)) || (method === "POST" && ACT_PATH.test(path));
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const manages = (standing: SetupRunStanding): boolean => standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin");

export interface HostedIntakeAppInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  companyId: OrgId;
  flow: Pick<TaskFlowDeps, "projects">;
  wiring: HostedIntakeAppWiring;
  intake: HostedIntakeApp;
}

/** The project the request names, once the caller's live standing and the company's own catalog say they may see it; the same 404 for every way of not being allowed to know. Throws the answer's error. */
async function projectOfRequest(input: HostedIntakeAppInput, rawProject: string): Promise<string> {
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", INTAKE_WORDS.projectNotFound); }
  if (!WikiProjectSchema.safeParse(project).success) throw agentXError("NOT_FOUND", INTAKE_WORDS.projectNotFound);
  let standing: SetupRunStanding;
  try { standing = await input.wiring.standing(input.principal.personId, input.companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_WORDS.unavailable); }
  // Anything but the two answers is no answer: read as none (never as manage).
  if (!manages(standing) && standing?.access !== "view") throw agentXError("NOT_FOUND", INTAKE_WORDS.projectNotFound);
  let latest;
  try { latest = await input.flow.projects.latest(project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_WORDS.unavailable); }
  if (latest === undefined) throw agentXError("NOT_FOUND", INTAKE_WORDS.projectNotFound);
  if (!manages(standing)) throw agentXError("FORBIDDEN", INTAKE_WORDS.adminOnly);
  return project;
}

/** The waiting list, each row saying for THIS person why it waits and whether they may Start or dismiss it. */
async function listFor(input: HostedIntakeAppInput, project: string): Promise<BrokerResponse> {
  const { companyId, intake } = input;
  try {
    const waiting = await intake.waiting(companyId, project);
    const canStart = waiting.items.length === 0 ? false : await intake.mayStart(companyId, project, input.principal.personId);
    return json(200, { ...waiting, items: waiting.items.map((item) => ({ ...item, reasonWords: INTAKE_WAIT_REASON_WORDS[item.reason], canStart, canDismiss: true })) });
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_WORDS.unavailable); }
}

/** "Not this one", as the signed-in person. */
async function dismissItem(input: HostedIntakeAppInput, project: string, itemId: string): Promise<BrokerResponse> {
  let dismissed: boolean;
  try { dismissed = await input.intake.dismiss(input.companyId, project, itemId, input.principal.personId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_WORDS.unavailable); }
  if (!dismissed) throw agentXError("NOT_FOUND", INTAKE_WORDS.noTicket);
  return json(200, { dismissed: true });
}

/** "Start", as the signed-in person: the work is theirs. A fault that may pass (the start service away) is a 503; the ticket was given back and waits, so pressing again works. */
async function startItem(input: HostedIntakeAppInput, project: string, itemId: string): Promise<BrokerResponse> {
  let outcome: Awaited<ReturnType<HostedIntakeApp["start"]>>;
  try { outcome = await input.intake.start(input.companyId, project, itemId, input.principal.personId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_WORDS.unavailable); }
  if (outcome.outcome === "not_found") throw agentXError("NOT_FOUND", INTAKE_WORDS.noTicket);
  if (outcome.outcome === "forbidden") throw agentXError("FORBIDDEN", INTAKE_WORDS.cannotStart);
  if (outcome.outcome === "started") return json(200, { started: true, taskId: outcome.taskId, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) });
  return json(200, outcome.outcome === "waiting" ? { started: false, reason: outcome.reason } : { started: false, state: outcome.state });
}

/** A press: the body must be `{ requestId }` and the ticket id the shape of one, before anything is asked of the intake. */
async function actOn(input: HostedIntakeAppInput, project: string, itemId: string, verb: string): Promise<BrokerResponse> {
  let body: unknown;
  try { body = input.request.body === undefined || input.request.body === "" ? {} : JSON.parse(input.request.body) as unknown; } catch { body = undefined; }
  if (!(verb === "start" ? IntakeStartBodySchema : IntakeDismissBodySchema).safeParse(body).success) throw agentXError("CONFIG_INVALID", INTAKE_WORDS.badBody);
  if (!ITEM_ID.test(itemId)) throw agentXError("NOT_FOUND", INTAKE_WORDS.noTicket);
  return verb === "dismiss" ? dismissItem(input, project, itemId) : startItem(input, project, itemId);
}

/** One request on a waiting-ticket path (`isIntakePath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedIntake(input: HostedIntakeAppInput): Promise<BrokerResponse> {
  try {
    const act = ACT_PATH.exec(input.path);
    const list = act === null ? LIST_PATH.exec(input.path) : null;
    const rawProject = (act ?? list)?.[1];
    if (rawProject === undefined) throw agentXError("NOT_FOUND", "route not found");
    const project = await projectOfRequest(input, rawProject);
    return act === null ? await listFor(input, project) : await actOn(input, project, act[2]!, act[3]!);
  } catch (error) {
    return errorAnswer(error instanceof AgentXError ? error : agentXError("RUNTIME_UNAVAILABLE", INTAKE_WORDS.unavailable));
  }
}
