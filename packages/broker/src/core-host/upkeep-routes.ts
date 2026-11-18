// Nightly upkeep's switch on the hosted core (lead 4 N1): the same family as the wiki build controls (`/v1/app/projects/{project}/...`), served AS the signed-in person:
//
//   GET /v1/app/projects/{project}/upkeep   { enabled, canManage }: any role on the project reads it
//   PUT /v1/app/projects/{project}/upkeep   { requestId, on }: a live company owner or admin, or an administrator of the project, switches it; answers { enabled, canManage }
//
// Rules (the wiki build controls' and the setup run's, reused: `standing` is the one live read of a person's standing):
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, query, body or token claim; a script token never reaches this route (the dev routes refuse it first). Every row is
//     keyed by that company AND the project.
//   - Anyone with no role on the project, another company's project, a missing one and a malformed name all answer the same 404 "project not found". A reader's change is 403 in fixed words.
//   - Off by default. The same request id with the same choice is one act (a replay answers the view and records nothing); the same id with the other choice is a new act.
//   - The audit record (naming the person and why they were allowed) is written BEFORE the row: nothing changes when it cannot be written. Refusals are fixed words, nothing a caller sent is echoed.
//   - The monthly dollar cap is not here: the gateway holds it (Cloud's Spending limits page). This route only switches the nights on.
import { AgentXError, WikiProjectSchema, agentXError, type AuditEvent, type AuditSink, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { UPKEEP_WORDS, upkeepSwitchControl, upkeepView, type UpkeepSettingsDeps } from "../core/upkeep/settings.js";
import type { UpkeepScope } from "../core/upkeep/keys.js";
import type { SetupRunBasis, SetupRunStanding } from "./setup-run-routes.js";

export interface HostedUpkeepWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** Whether nightly runs really happen for this company on this deployment: a system starter AND the schedule are wired. Absent: false, the switch stays hidden and a change is refused. */
  available?: ((companyId: OrgId) => boolean) | undefined;
  /** The project's upkeep night on the scheduler (put when ON, removed when OFF). Absent: this deployment has no scheduler for it yet, and the switch is only recorded. */
  schedule?: ((companyId: OrgId) => { put(scope: UpkeepScope): Promise<void>; remove(scope: UpkeepScope): Promise<void> }) | undefined;
}

export interface HostedUpkeepInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedUpkeepWiring;
  audit: AuditSink;
  now: () => number;
}

const UPKEEP_PATH = /^\/v1\/app\/projects\/([^/]+)\/upkeep$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is the upkeep switch's. */
export function isUpkeepPath(path: string, method: string): boolean {
  return UPKEEP_PATH.test(path) && (method === "GET" || method === "PUT");
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", UPKEEP_WORDS.projectNotFound);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", UPKEEP_WORDS.unreadable);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request is not valid"); }
}

const isManage = (standing: SetupRunStanding): standing is Extract<SetupRunStanding, { access: "manage" }> =>
  standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin");

/** One request on the hosted upkeep path (`isUpkeepPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedUpkeep(input: HostedUpkeepInput): Promise<BrokerResponse> {
  try {
    const match = UPKEEP_PATH.exec(input.path);
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
    const live: UpkeepSettingsDeps["standing"] = async (person, name) => {
      let now: SetupRunStanding;
      try { now = await wiring.standing(person, companyId, name); } catch { return { access: "none" }; }
      return isManage(now) ? { access: "manage" } : now?.access === "view" ? { access: "view" } : { access: "none" };
    };
    const deps: UpkeepSettingsDeps = {
      store: flow.store, companyId, now: input.now, standing: live, schedule: wiring.schedule?.(companyId), available: wiring.available === undefined ? undefined : () => wiring.available!(companyId),
      record: async (action, name, details) => {
        const basis: SetupRunBasis | undefined = isManage(standing) ? standing.basis : undefined;
        const event: AuditEvent = {
          // The choice is in the id: the same request id with the other choice is another act and must not be deduped as a replay.
          eventId: `upkeep.${action}:${companyId}:${name}:${personId}:${details.requestId}:${details.on ? "on" : "off"}:${details.previous}`, companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: personId },
          action: `upkeep.${action}`, subject: { type: "project", id: name }, details: { project: name, ...(basis === undefined ? {} : { basis }), requestId: details.requestId, on: details.on, previous: details.previous },
        };
        await input.audit.record(event);
      },
    };
    if (input.request.method === "GET") return json(200, await upkeepView(deps, personId, project));
    if (input.request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    if (!isManage(standing)) throw agentXError("FORBIDDEN", UPKEEP_WORDS.notAllowed);
    return json(200, await upkeepSwitchControl(deps, personId, project, bodyOf(input.request)));
  } catch (error) {
    if (error instanceof AgentXError) {
      // The core names a missing project with its name; here every missing or unseen project reads the same.
      if (error.code === "PROJECT_NOT_FOUND") return errorAnswer(notFound());
      return errorAnswer(error);
    }
    return errorAnswer(unavailable());
  }
}
