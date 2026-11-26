// Audit gap 11b (2026-11-18): a project's ticket-sharing settings (Linear ticket updates) on the hosted core, the laptop handler's own route (core-host/app/intake.ts) and answers, served AS the signed-in person:
//
//   GET /v1/app/projects/{project}/intake/updates   { settings, canEdit, access }: any role on the project reads it (contracts/ticket-updates.ts `TicketUpdatesViewSchema`)
//   PUT /v1/app/projects/{project}/intake/updates   { requestId, settings } (`TicketUpdatesPutBodySchema`): a live company owner or admin, or the project's administrator, replaces them; answers the view
//
// The laptop has one person, its owner, who reads and changes these (`canEdit: true`). Hosted, the owner is the company's people, so the rule is the hosted project settings' rule (DEC 254n item 3, the setup
// run's `lifecycleAccess` standing, as the waiting tickets and the Linear team use it): a company owner or admin, or the project's administrator, changes; anyone else with a role on the project reads.
//
// Rules (the upkeep switch's, reused):
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, query, body or token claim; a script token never reaches this route (the dev routes refuse it first). The settings
//     and the write-access rows are the core's own (core/ticket-updates/settings.ts), keyed by that company AND the project: the same rows the company's ticket write-back reads (aws/hosted-intake.ts).
//   - Anyone with no role on the project, another company's project, a missing one and a malformed name all answer the same 404 "project not found". A reader's change is 403 in fixed words.
//   - The same request id with the same settings is one act (the store answers what is saved); the same id with other settings is refused. A save is conditional on the revision read.
//   - The audit record (naming the person, why they were allowed, and the level asked for) is written BEFORE the row: nothing changes when it cannot be written. Refusals are fixed words.
import { createHash } from "node:crypto";
import { AgentXError, TicketUpdatesPutBodySchema, WikiProjectSchema, agentXError, type AuditEvent, type AuditSink, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { readTicketUpdates, readWriteAccess, saveTicketUpdates } from "../core/ticket-updates/settings.js";
import type { SetupRunBasis, SetupRunStanding } from "./setup-run-routes.js";

export interface HostedTicketUpdatesWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** The trackers this deployment writes tickets back to for a company (hosted: Linear, over the company's own connection). Each one's write access is shown as last seen. */
  trackers: readonly string[];
}

export interface HostedTicketUpdatesInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  companyId: OrgId;
  flow: Pick<TaskFlowDeps, "store" | "projects">;
  wiring: HostedTicketUpdatesWiring;
  audit: Pick<AuditSink, "record">;
  now: () => number;
}

export const TICKET_UPDATES_WORDS = {
  projectNotFound: "project not found",
  notAllowed: "Only a company owner or admin, or the project's admin, can change what Rovara writes on its tickets.",
  unreadable: "The ticket sharing settings could not be read just now; try again.",
  badRequest: "Send { requestId, settings } with the ticket sharing settings.",
  requestIdReused: "This request id was already used for other settings.",
} as const;

const TICKET_UPDATES_PATH = /^\/v1\/app\/projects\/([^/]+)\/intake\/updates$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is the ticket-sharing settings route. */
export function isTicketUpdatesPath(path: string, method: string): boolean {
  return TICKET_UPDATES_PATH.test(path) && (method === "GET" || method === "PUT");
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", TICKET_UPDATES_WORDS.projectNotFound);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", TICKET_UPDATES_WORDS.unreadable);

const isManage = (standing: SetupRunStanding): standing is Extract<SetupRunStanding, { access: "manage" }> =>
  standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin");

function putBodyOf(request: BrokerRequest) {
  let value: unknown;
  try { value = request.body === undefined || request.body === "" ? undefined : JSON.parse(request.body) as unknown; } catch { value = undefined; }
  const parsed = TicketUpdatesPutBodySchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", TICKET_UPDATES_WORDS.badRequest);
  return parsed.data;
}

/** One request on the hosted ticket-sharing settings path (`isTicketUpdatesPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedTicketUpdates(input: HostedTicketUpdatesInput): Promise<BrokerResponse> {
  try {
    const match = TICKET_UPDATES_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!PROJECT_NAME.test(project) || !WikiProjectSchema.safeParse(project).success) throw notFound();
    const { flow, companyId, wiring } = input;
    const personId = input.principal.personId;
    let standing: SetupRunStanding;
    try { standing = await wiring.standing(personId, companyId, project); } catch { throw unavailable(); }
    // Anything but the two answers is no answer: read as none (never as manage).
    if (!isManage(standing) && standing?.access !== "view") throw notFound();
    // The project is read in the caller's company only.
    let latest;
    try { latest = await flow.projects.latest(project); } catch { throw unavailable(); }
    if (latest === undefined) throw notFound();
    const table = { store: flow.store, now: input.now };
    const canEdit = isManage(standing);
    const view = async (settings?: Awaited<ReturnType<typeof readTicketUpdates>>["settings"]) => {
      try {
        return { settings: settings ?? (await readTicketUpdates(table, companyId, project)).settings, canEdit, access: await readWriteAccess(table, companyId, wiring.trackers) };
      } catch { throw unavailable(); }
    };
    if (input.request.method === "GET") return json(200, await view());
    if (input.request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    if (!isManage(standing)) throw agentXError("FORBIDDEN", TICKET_UPDATES_WORDS.notAllowed);
    const body = putBodyOf(input.request);
    const basis: SetupRunBasis = standing.basis;
    // A request id already used for other settings is refused before anything is recorded (the save would refuse it too): the audit trail never names a change that did not happen.
    let current: Awaited<ReturnType<typeof readTicketUpdates>>;
    try { current = await readTicketUpdates(table, companyId, project); } catch { throw unavailable(); }
    if (current.requestId === body.requestId && JSON.stringify(current.settings) !== JSON.stringify(body.settings)) throw agentXError("CONFIG_INVALID", TICKET_UPDATES_WORDS.requestIdReused);
    // The settings are in the id: the same request id with other settings is another act (the save then refuses it), never deduped as a replay.
    const digest = createHash("sha256").update(JSON.stringify(body.settings)).digest("hex").slice(0, 32);
    const event: AuditEvent = {
      eventId: `ticket_updates.changed:${companyId}:${project}:${personId}:${body.requestId}:${digest}`, companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: personId },
      action: "ticket_updates.changed", subject: { type: "project", id: project },
      details: { project, basis, requestId: body.requestId, comments: body.settings.comments, changeStatus: body.settings.changeStatus, level: body.settings.level ?? "status_only" },
    };
    await input.audit.record(event);
    const saved = await saveTicketUpdates(table, { orgId: companyId, project, settings: body.settings, requestId: body.requestId, by: personId });
    return json(200, await view(saved));
  } catch (error) {
    if (error instanceof AgentXError) {
      // The core names a missing project with its name; here every missing or unseen project reads the same.
      if (error.code === "PROJECT_NOT_FOUND") return errorAnswer(notFound());
      return errorAnswer(error);
    }
    return errorAnswer(unavailable());
  }
}
