// Person erase on the deployed API (row 13.1): `POST /v1/app/people/<personId>/erase`, mountable next to the core's own handlers behind the switch (`ROVARA_CORE_ENGINE`, default off).
//
// Rules:
//   - Off (the default) is byte-identical: `route` answers `undefined` for every request without reading anything.
//   - The caller's company and live role come from MEMBERSHIP (`companyOf`), never from a header, a query, a body or a token claim; a reader that throws or answers nothing is a sign-in refusal.
//     The principal the sign-in vouched for must be of that company.
//   - Only an owner or an admin of the company may erase (the live role from membership), and only from the Rovara website's own client (DEC 254zzz91); a script
//     token, the CLI's token or an AI tool's never can. DEC 254zzz73: no step-up.
//   - A person never erases themselves here (another admin does it), so nobody can lock a company out of its last admin by mistake.
//   - Only a person the company REMOVED is erased (`standing`, from the company's own records): a current member is refused (remove them first, so their sign-in, sessions and script tokens stop),
//     and a person the company never had answers "not found", exactly like a malformed id, so the route cannot be used to probe other companies' people.
//   - The erase is the engine's (`erasePerson`), company-scoped to the member company, and repeatable with the same request id. The answer is the receipt (counts, no names); refusals are fixed words.
import { AgentXError, ON_THE_WEBSITE_MESSAGE, OrgRoleSchema, PERSON_ERASE_OWED_WORDS, PersonEraseReceiptSchema, PersonEraseRequestSchema, agentXError, type OrgRole, type Principal } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { erasePerson, isErasablePersonId, type PersonEraseDeps } from "../core/people/erase.js";
import type { CoreHostApp } from "./app.js";

const ERASE_PATH = /^\/v1\/app\/people\/([^/]+)\/erase$/u;
const ORG_ID = /^org_[0-9a-z]{20}$/u;

export const ERASE_NEEDS_ADMIN = "Only an owner or an admin of the company can erase a person.";
export const ERASE_NOT_YOURSELF = "You cannot erase yourself here. Ask another admin of the company.";
export const ERASE_REMOVE_FIRST = "Remove this person from the company first, then erase them.";
export const ERASE_NOT_FOR_SCRIPT_TOKENS = "A script token cannot do that.";
const SIGN_IN_AGAIN = "Sign in again.";

export interface PersonEraseCaller {
  principal: Principal;
  scriptToken?: { tokenId: string } | undefined;
  /** Owner DEC 254zzz91: set by the broker's sign-in for the Rovara website's own client only; never from a request. */
  webApp?: true | undefined;
}

export interface PersonEraseRouteOptions {
  app: Pick<CoreHostApp, "serving">;
  companyOf(caller: PersonEraseCaller): Promise<{ companyId: string; role: OrgRole } | undefined>;
  /** The engine erase's ports for this company (the State store, the evidence bucket's version delete, the company's audit sink, the learning erase). */
  eraseDeps(companyId: string): PersonEraseDeps;
  /** What the company's own records say about a person: a current `member`, a `former` member (removed), or `unknown` (never one of its people). Anything else, or a throw, refuses with 503. */
  standing(companyId: string, personId: string): Promise<"member" | "former" | "unknown">;
  log?: (entry: Record<string, unknown>) => void;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

export function createPersonEraseRoute(options: PersonEraseRouteOptions): { route(request: BrokerRequest, caller: PersonEraseCaller): Promise<BrokerResponse | undefined> } {
  return {
    async route(request, caller) {
      if (!options.app.serving) return undefined;
      const path = request.path.split("?")[0] ?? request.path;
      const match = ERASE_PATH.exec(path);
      if (match === null || request.method !== "POST") return undefined;
      try {
        let membership: { companyId: string; role: OrgRole } | undefined;
        try { membership = await options.companyOf(caller); } catch { membership = undefined; }
        if (membership === undefined || membership === null || typeof membership !== "object" || typeof membership.companyId !== "string" || !ORG_ID.test(membership.companyId) || !OrgRoleSchema.safeParse(membership.role).success) return json(401, { error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });
        const companyId = membership.companyId;
        if (caller.principal.companyId !== companyId) return json(401, { error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });
        if (caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", ERASE_NOT_FOR_SCRIPT_TOKENS);
        if (membership.role !== "owner" && membership.role !== "admin") throw agentXError("FORBIDDEN", ERASE_NEEDS_ADMIN);
        // Owner DEC 254zzz91: erasing a person is done only from the Rovara website's own client, never by a CLI or AI-tool token.
        if (caller.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
        let target: string;
        try { target = decodeURIComponent(match[1]!); } catch { throw agentXError("NOT_FOUND", "route not found"); }
        if (!isErasablePersonId(target)) throw agentXError("NOT_FOUND", "route not found");
        if (target === caller.principal.personId) throw agentXError("FORBIDDEN", ERASE_NOT_YOURSELF);
        const body = PersonEraseRequestSchema.safeParse(bodyOf(request));
        if (!body.success) throw agentXError("CONFIG_INVALID", "the request body must be { requestId } with a UUID");
        let standing: unknown;
        try { standing = await options.standing(companyId, target); } catch { standing = undefined; }
        if (standing === "unknown") throw agentXError("NOT_FOUND", "route not found");
        if (standing === "member") throw agentXError("FORBIDDEN", ERASE_REMOVE_FIRST);
        if (standing !== "former") throw agentXError("RUNTIME_UNAVAILABLE", "The company's records could not be read just now, so nothing was done. Try again in a moment.");
        const deps = options.eraseDeps(companyId);
        const receipt = PersonEraseReceiptSchema.parse(await erasePerson(deps, { companyId, personId: target, by: caller.principal.personId, requestId: body.data.requestId }));
        return json(200, { receipt, ...(receipt.evidence === "owed" ? { message: PERSON_ERASE_OWED_WORDS } : {}) });
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        options.log?.({ event: "person_erase.failed", error: error instanceof Error ? error.name : "unknown" });
        return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", "The erase could not be finished just now. Send the same request again."));
      }
    },
  };
}
