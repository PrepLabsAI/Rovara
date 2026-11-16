// The company's agent model choice on the deployed API (DEC 243c, DEC 236j): `GET /v1/app/agent-models` and `POST /v1/app/agent-models`, mounted by the engine host's dev routes (dev-routes.ts).
//
//   GET   any member of the company: the per-step model setting (`ModelSelectionState`) and every model the gateway offers the company now (the picker's whole list).
//   POST  the company's change (`ModelSelectionBody`): ONLY on the web page, right after a fresh step-up the route checks itself (a tool with an API token or a script token has none: fixed words), and only by
//         an owner or an administrator of the company (the live role from membership, never a claim). The model must be on the gateway's list now; a less-safe change needs the company's approval rule.
//
// The company is the caller's membership (the dev routes read it); the rule, the list and the setting are that company's own. Every refusal is a fixed sentence: no company id or cause is echoed (a refused model is named only back to the caller who named it).
import { agentXError, type AuditSink, type OrgRole, type Principal } from "@agentx/contracts";
import type { BrokerResponse } from "../handler.js";
import { OfferedModelsUnavailable, OFFERED_MODELS_UNAVAILABLE, type AgentModelChoice } from "./gateway-model-selection.js";

export const AGENT_MODELS_PATH = "/v1/app/agent-models";
/** What a change without a fresh page sign-in says (an API token or a script token cannot make it). */
export const AGENT_MODEL_CHANGE_ON_A_PAGE = "The model your agents use is changed on the web page, right after you confirm it's you on the sign-in page: a tool that holds an API token cannot change it. Confirm it's you, then try again within a few minutes.";
export const AGENT_MODEL_CHANGE_NOT_ALLOWED = "Only an owner or an administrator of the company can change the model its agents use.";
const BODY_INVALID = "That is not a change the model setting offers.";

export interface AgentModelRequest {
  method: string;
  body: string | undefined;
  principal: Principal;
  role: OrgRole;
  choice: AgentModelChoice;
  /** The audit sink for this caller (the wiring's `auditFor`), or the company's own. */
  audit: AuditSink | undefined;
  /** Checks the caller's step-up is fresh now for the company (throws the sign-in refusal with these words) and returns it. */
  freshStepUp(refusal: string): Promise<{ at: string; method: string }>;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

function bodyOf(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") throw agentXError("CONFIG_INVALID", BODY_INVALID);
  try { return JSON.parse(raw) as unknown; } catch { throw agentXError("CONFIG_INVALID", BODY_INVALID); }
}

export async function agentModelRoute(request: AgentModelRequest): Promise<BrokerResponse> {
  if (request.method === "GET") {
    try {
      const service = request.choice.service();
      const [state, offered] = await Promise.all([service.state(), request.choice.offered()]);
      return json(200, { state, offered: { version: 1, models: offered } });
    } catch (error) {
      if (error instanceof OfferedModelsUnavailable) throw agentXError("RUNTIME_UNAVAILABLE", OFFERED_MODELS_UNAVAILABLE);
      throw agentXError("RUNTIME_UNAVAILABLE", "The model setting could not be read just now.");
    }
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
  // The page's fresh step-up first (no one learns more than "confirm it's you"), then the live role, then the body.
  const stepUp = await request.freshStepUp(AGENT_MODEL_CHANGE_ON_A_PAGE);
  if (request.role !== "owner" && request.role !== "admin") throw agentXError("FORBIDDEN", AGENT_MODEL_CHANGE_NOT_ALLOWED);
  // The rule checks the body itself (a body that is not a change is refused in these same words).
  const body = bodyOf(request.body);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop them
  const { authTime: _ignored, methods: _alsoIgnored, ...person } = request.principal;
  const principal: Principal = { ...person, authTime: stepUp.at, methods: [stepUp.method] };
  const result = await request.choice.service(request.audit).apply(principal, body, { fresh: true });
  if (result.ok) return json(200, { ok: true, revision: result.revision, lessSafe: result.lessSafe });
  switch (result.code) {
    case "reauth_required": throw agentXError("REAUTH_REQUIRED", result.words);
    case "stale": throw agentXError("CHANGE_STALE", result.words);
    case "second_person_required": throw agentXError("FORBIDDEN", result.words);
    case "approval_unavailable": case "settings_unreadable": throw agentXError("RUNTIME_UNAVAILABLE", result.words);
    default: throw agentXError("CONFIG_INVALID", result.words);
  }
}
