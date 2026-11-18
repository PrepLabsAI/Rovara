// Nightly upkeep's switch on `rovara up` (lead 4 N1). The same path and answers as the hosted core (core-host/upkeep-routes.ts):
//
//   GET /v1/app/projects/{project}/upkeep   { enabled, canManage }
//   PUT /v1/app/projects/{project}/upkeep   { requestId, on }
//
// Who: the owner of this install, on the API session (the owner manages every project of the install). A script token never reaches this route. A project that does not exist answers 404 "project not found".
// The install has one company (`IMPLICIT_COMPANY_ID`); every row is still keyed by it AND the project. Nothing AI-spending starts on a laptop by itself (its Admission declares no enforced dollar cap), so ON here
// records the choice and runs only the free steps once a scheduler is subscribed; the page says that automatic fixes need a spending limit.
import { AgentXError, IMPLICIT_COMPANY_ID, agentXError, type AuditSink, type OrgId, type Principal } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { UPKEEP_WORDS, upkeepSwitchControl, upkeepView, type UpkeepSettingsDeps } from "../../core/upkeep/settings.js";

const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/upkeep$/u;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const bodyOf = (request: BrokerRequest): unknown => {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request is not valid"); }
};

export interface LocalUpkeepOptions {
  flow: TaskFlowDeps;
  owner: Principal;
  companyId?: OrgId | undefined;
  audit: AuditSink;
  now: () => number;
  schedule?: UpkeepSettingsDeps["schedule"];
  /** Whether this install has a local runner for nightly upkeep. Absent: no (the switch stays hidden); `rovara up` wires none yet. */
  available?: (() => boolean) | undefined;
}

export interface LocalUpkeep { routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> }

export function createLocalUpkeep(options: LocalUpkeepOptions): LocalUpkeep {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const { flow } = options;
  return {
    async routes(request, caller) {
      const url = request.path.split("?")[0] ?? request.path;
      const match = ROUTE.exec(url);
      if (match === null || (request.method !== "GET" && request.method !== "PUT")) return undefined;
      try {
        if (caller.scriptToken !== undefined || !caller.principal.roles.includes("owner")) throw agentXError("FORBIDDEN", UPKEEP_WORDS.notAllowed);
        const project = match[1]!;
        if ((await flow.projects.latest(project)) === undefined) throw agentXError("PROJECT_NOT_FOUND", UPKEEP_WORDS.projectNotFound);
        const personId = caller.principal.personId;
        const deps: UpkeepSettingsDeps = {
          store: flow.store, companyId, now: options.now, standing: async () => ({ access: "manage" }), schedule: options.schedule, available: options.available,
          record: async (action, name, details) => {
            await options.audit.record({
              eventId: `upkeep.${action}:${companyId}:${name}:${personId}:${details.requestId}:${details.on ? "on" : "off"}:${details.previous}`, companyId, at: new Date(options.now()).toISOString(), actor: { type: "person", id: personId },
              action: `upkeep.${action}`, subject: { type: "project", id: name }, details: { project: name, requestId: details.requestId, on: details.on, previous: details.previous },
            });
          },
        };
        if (request.method === "GET") return json(200, await upkeepView(deps, personId, project));
        return json(200, await upkeepSwitchControl(deps, personId, project, bodyOf(request)));
      } catch (error) {
        if (error instanceof AgentXError) {
          if (error.code === "PROJECT_NOT_FOUND") return json(404, { error: { code: "NOT_FOUND", message: UPKEEP_WORDS.projectNotFound } });
          return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        }
        return json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: UPKEEP_WORDS.unreadable } });
      }
    },
  };
}
