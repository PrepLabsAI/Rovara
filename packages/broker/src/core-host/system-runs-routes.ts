// The company's ONE control over Rovara's automatic runs on the hosted core (L4-P3, owner 2026-11-17), served AS the signed-in person:
//
//   GET /v1/app/company/system-runs   { available, allowed, systemRunsOn }: a live company owner or admin reads it (contracts/upkeep.ts `SystemRunsViewSchema`)
//   PUT /v1/app/company/system-runs   { requestId, allowed }: a live company owner or admin allows or withdraws it; answers the view after the change
//
// Rules (core/system-runs/consent-control.ts holds them; this file only reads who is asking and writes the audit record):
//   - The company and the live role are the caller's MEMBERSHIP (the dev routes' `companyOf`), never a header, query, body or token claim. A script token never reaches this route (the dev routes refuse it first).
//   - ALLOWING needs the live role and the operator ceiling (DEC 254zzz73: no step-up); WITHDRAWING needs only the live role and works while the operator's ceiling is off. Withdrawing leaves every project's own switch as it is.
//   - The audit record (`system_runs.consent_set`: the person, the role, the choice, and for an allow the factor) is written BEFORE the row. Refusals are fixed words; nothing a caller sent is echoed.
import { AgentXError, SYSTEM_RUNS_CONSENT_AUDIT, agentXError, type AuditEvent, type AuditSink, type OrgId, type OrgRole } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { SYSTEM_RUNS_WORDS, setSystemRunsConsent, systemRunsView, type SystemRunsControlDeps } from "../core/system-runs/consent-control.js";

export interface HostedSystemRunsInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  companyId: OrgId;
  flow: TaskFlowDeps;
  /** The caller's role in this company as membership says NOW (read for this request by the dev routes). Only `owner` and `admin` may use this route. */
  role: OrgRole;
  /** Whether the operator's ceiling covers this company (the upkeep wiring's `available`). Absent: not available. */
  available?: ((companyId: OrgId) => boolean) | undefined;
  audit: AuditSink;
  now: () => number;
  /** Owner DEC 254zzz91: the caller is the Rovara website's own client (set by the broker's sign-in, never from a request). */
  webApp?: boolean | undefined;
}

const SYSTEM_RUNS_PATH = "/v1/app/company/system-runs";

/** Whether this method and path is the company's automatic-runs control. */
export function isSystemRunsPath(path: string, method: string): boolean {
  return path === SYSTEM_RUNS_PATH && (method === "GET" || method === "PUT");
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request is not valid"); }
}

/** One request on the company's automatic-runs path (`isSystemRunsPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedSystemRuns(input: HostedSystemRunsInput): Promise<BrokerResponse> {
  try {
    const { companyId, principal } = input;
    const personId = principal.personId;
    const role = input.role;
    const admin = role === "owner" || role === "admin";
    const deps: SystemRunsControlDeps = {
      store: input.flow.store, companyId, now: input.now, isCompanyAdmin: async () => admin, webApp: input.webApp === true,
      available: input.available === undefined ? undefined : () => input.available!(companyId),
      record: async (details) => {
        const event: AuditEvent = {
          eventId: `${SYSTEM_RUNS_CONSENT_AUDIT}:${companyId}:${personId}:${details.requestId}:${details.on ? "on" : "off"}:${details.previous}`, companyId, at: new Date(input.now()).toISOString(),
          actor: { type: "person", id: personId }, action: SYSTEM_RUNS_CONSENT_AUDIT, subject: { type: "company", id: companyId },
          details: { basis: role === "owner" ? "company-owner" : "company-admin", requestId: details.requestId, on: details.on, previous: details.previous },
        };
        await input.audit.record(event);
      },
    };
    if (input.path !== SYSTEM_RUNS_PATH) throw agentXError("NOT_FOUND", "route not found");
    if (input.request.method === "GET") return json(200, await systemRunsView(deps));
    if (input.request.method === "PUT") return json(200, await setSystemRunsConsent(deps, () => bodyOf(input.request)));
    throw agentXError("NOT_FOUND", "route not found");
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", SYSTEM_RUNS_WORDS.unreadable));
  }
}
