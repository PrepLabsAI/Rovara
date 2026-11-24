// The company's package tokens, on the deployed core's /v1/app routes (PRIVATE-PACKAGES P1b), served AS the signed-in person (contracts company-package-registries.ts; rules in
// core/project-registries/company-registry-control.ts):
//
//   GET    /v1/app/company/package-registries   any live company member   the status line of each supported host: set on <date> by <who>, or not set. NEVER a value.
//   PUT    /v1/app/company/package-registries   live owner or admin        { requestId, expectedRevision, host, scopes, token }  set or replace (validated against GitHub first)
//   DELETE /v1/app/company/package-registries   live owner or admin        { requestId, expectedRevision, host }                 delete (the secret keeps its 7 day recovery window)
//
// Rules:
//   - The company and the role are the caller's LIVE membership (the dev routes' `companyOf`, read for this request), never a header, query, body or token claim. A script token never reaches this route.
//   - No route, in this file or anywhere, answers the stored token. The PUT body holds it once; nothing logs a body, an error says fixed words, and the answer is the status line.
//   - The audit record names the person, the host and the scopes, never the value; it is written before the secret changes.
import { AgentXError, COMPANY_PACKAGE_REGISTRIES_PATH, COMPANY_REGISTRY_WORDS, agentXError, type AuditEvent, type AuditSink, type JsonObject, type OrgId, type OrgRole } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { companyRegistriesView, deleteCompanyRegistryToken, putCompanyRegistryToken, type RegistryControlDeps, type RegistrySecretStore } from "../core/project-registries/company-registry-control.js";
import { githubScopeProbe, type GithubScopeProbe } from "../core/project-registries/token-check.js";

export interface HostedPackageRegistriesWiring {
  /** The install's name for secrets (`agentx/<env>/...`; "production" on the legacy install). */
  env: string;
  /** The company's secret store: the company-tagged session of the CompanySecrets role. Only this route's writes and deletes are made through it. */
  secrets: RegistrySecretStore;
  /** The scope check against GitHub (a fake in tests). Absent: the real call. */
  probe?: GithubScopeProbe | undefined;
}

export interface HostedPackageRegistriesInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  /** The caller's live role in the member company (membership, never a claim). */
  role: OrgRole;
  companyId: OrgId;
  flow: Pick<TaskFlowDeps, "store">;
  wiring: HostedPackageRegistriesWiring;
  audit: Pick<AuditSink, "record">;
  now: () => number;
}

/** Whether this method and path is the company's package token control. */
export function isPackageRegistriesPath(path: string, method: string): boolean {
  return path === COMPANY_PACKAGE_REGISTRIES_PATH && (method === "GET" || method === "PUT" || method === "DELETE");
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", COMPANY_REGISTRY_WORDS.bodyInvalid); }
}

/** One request on the package token path (`isPackageRegistriesPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedPackageRegistries(input: HostedPackageRegistriesInput): Promise<BrokerResponse> {
  try {
    const { companyId, principal } = input;
    const personId = principal.personId;
    const deps: RegistryControlDeps = {
      store: input.flow.store, companyId, env: input.wiring.env, secrets: input.wiring.secrets, probe: input.wiring.probe ?? githubScopeProbe(), now: input.now, personId, role: input.role,
      record: async (action: string, requestId: string, details: JsonObject) => {
        const event: AuditEvent = {
          eventId: `${action}:${companyId}:${requestId}`, companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: personId }, action,
          subject: { type: "company", id: companyId }, details,
        };
        await input.audit.record(event);
      },
    };
    if (input.path !== COMPANY_PACKAGE_REGISTRIES_PATH) throw agentXError("NOT_FOUND", "route not found");
    switch (input.request.method) {
      case "GET": return json(200, await companyRegistriesView(deps));
      case "PUT": return json(200, await putCompanyRegistryToken(deps, () => bodyOf(input.request)));
      case "DELETE": return json(200, await deleteCompanyRegistryToken(deps, () => bodyOf(input.request)));
      default: throw agentXError("NOT_FOUND", "route not found");
    }
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", COMPANY_REGISTRY_WORDS.unavailable));
  }
}
