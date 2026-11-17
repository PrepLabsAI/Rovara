// DEC 254w: the connected sign-ins routes on the developer API. Cloud's profile ("Connected sign-ins") calls them AS the signed-in person, through its
// full-access web-app sign-in client; a company owner or admin reads and removes a person's connected sign-ins through the member paths.
//
//   GET    /v1/dev/me/sign-ins                                    the caller's sign-in methods (the first, and each connected one)
//   POST   /v1/dev/me/sign-ins/link                               start connecting a method: { method, challenge, returnTo, state } -> { authorizeUrl, linkId }
//   POST   /v1/dev/me/sign-ins/link/finish                        finish it in the SAME session: { linkId, linkCode, verifier } -> { method }
//   DELETE /v1/dev/me/sign-ins/{method}                           remove a connected method (fresh step-up)
//   GET    /v1/dev/company/members/{personId}/sign-ins            a company owner or admin: a person's methods
//   DELETE /v1/dev/company/members/{personId}/sign-ins/{method}   a company owner or admin: remove one (fresh step-up)
//
// The broker may not write the sign-in table: every route forwards to DeveloperIdentity (sign-in-links.ts), naming the caller ONLY by the developer
// id and session id of the verified token, and DeveloperIdentity checks that session, the step-up, the company and every link rule itself. Bodies
// are validated strictly here first; every refusal is fixed words that never echo what was sent.
import { z } from "zod";
import {
  LinkableSignInMethodSchema, SIGN_IN_LINK_TEXT, SignInLinkFinishBodySchema, SignInLinkStartBodySchema, agentXError,
  type SignInLinkFinishRequest, type SignInLinkFinishResponse, type SignInLinkRefusal, type SignInLinkStartRequest, type SignInLinkStartResponse,
  type SignInLinksListRequest, type SignInLinksListResponse, type SignInUnlinkRequest, type SignInUnlinkResponse,
} from "@agentx/contracts";
import type { AdaptedHttpRequest } from "./lambda.js";

export type SignInLinkRequest = SignInLinkStartRequest | SignInLinkFinishRequest | SignInLinksListRequest | SignInUnlinkRequest;
export type SignInLinkReply = SignInLinkStartResponse | SignInLinkFinishResponse | SignInLinksListResponse | SignInUnlinkResponse;
/** One call to DeveloperIdentity; a refusal of its own (`unavailable`) when it cannot be reached or answers something that does not read. */
export type SignInLinkForward = (request: SignInLinkRequest) => Promise<SignInLinkReply>;

const SIGN_INS = /^\/v1\/dev\/(?:me|company\/members\/([^/]+))\/sign-ins(?:\/(link|link\/finish|[^/]+))?$/u;
const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
const NoBody = z.object({}).strict();
const NOT_SET_UP = "connecting sign-ins is not set up in this deployment";

/** Whether this module answers the path. */
export function isSignInLinkPath(path: string): boolean {
  return SIGN_INS.test(path);
}

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

/** DeveloperIdentity's refusal as the API's error, with its fixed words. */
function refused(answer: SignInLinkRefusal): never {
  switch (answer.error) {
    case "signed_out": throw agentXError("AUTH_REQUIRED", SIGN_IN_LINK_TEXT.signedOut);
    case "reauth": throw agentXError("REAUTH_REQUIRED", SIGN_IN_LINK_TEXT.reauth);
    case "refused": throw agentXError("FORBIDDEN", SIGN_IN_LINK_TEXT.refused);
    case "forbidden": throw agentXError("FORBIDDEN", SIGN_IN_LINK_TEXT.forbidden);
    case "last_method": throw agentXError("FORBIDDEN", SIGN_IN_LINK_TEXT.lastMethod);
    case "not_found": throw agentXError("NOT_FOUND", SIGN_IN_LINK_TEXT.notFound);
    case "not_set_up": throw agentXError("NOT_FOUND", NOT_SET_UP);
    case "invalid_request": throw agentXError("CONFIG_INVALID", SIGN_IN_LINK_TEXT.invalid);
    default: throw agentXError("RUNTIME_UNAVAILABLE", SIGN_IN_LINK_TEXT.unavailable);
  }
}
function okOrRefused<T extends { ok: true }>(answer: T | SignInLinkRefusal): Omit<T, "ok"> {
  if (answer.ok !== true) refused(answer);
  const { ok: _ok, ...rest } = answer;
  void _ok;
  return rest;
}

export async function routeSignInLinks(forward: SignInLinkForward | undefined, caller: { developerId: string; sessionId: string }, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (forward === undefined) throw agentXError("NOT_FOUND", NOT_SET_UP);
  const match = SIGN_INS.exec(url.pathname);
  if (match === null) throw agentXError("NOT_FOUND", "route not found");
  // A session that is not a sign-in session (a registered service's own token has none) never reaches DeveloperIdentity.
  if (caller.sessionId === "") throw agentXError("AUTH_REQUIRED", SIGN_IN_LINK_TEXT.signedOut);
  const { developerId, sessionId } = caller;
  const rawPerson = match[1];
  const tail = match[2];
  let personDeveloperId = developerId;
  if (rawPerson !== undefined) {
    const person = PersonId.safeParse(rawPerson);
    // A malformed id reads as a person the caller may not see.
    if (!person.success) throw agentXError("NOT_FOUND", SIGN_IN_LINK_TEXT.notFound);
    personDeveloperId = person.data;
  }
  const parsedBody = body(request);
  if (tail === undefined && request.method === "GET") {
    return okOrRefused(await forward({ kind: "sign-in-links-list", developerId, sessionId, personDeveloperId }) as SignInLinksListResponse);
  }
  if (rawPerson === undefined && tail === "link" && request.method === "POST") {
    const start = SignInLinkStartBodySchema.safeParse(parsedBody);
    if (!start.success) throw agentXError("CONFIG_INVALID", SIGN_IN_LINK_TEXT.invalid);
    return okOrRefused(await forward({ kind: "sign-in-link-start", developerId, sessionId, ...start.data }) as SignInLinkStartResponse);
  }
  if (rawPerson === undefined && tail === "link/finish" && request.method === "POST") {
    const finish = SignInLinkFinishBodySchema.safeParse(parsedBody);
    if (!finish.success) throw agentXError("CONFIG_INVALID", SIGN_IN_LINK_TEXT.invalid);
    return okOrRefused(await forward({ kind: "sign-in-link-finish", developerId, sessionId, ...finish.data }) as SignInLinkFinishResponse);
  }
  if (tail !== undefined && tail !== "link" && tail !== "link/finish" && request.method === "DELETE") {
    const method = LinkableSignInMethodSchema.safeParse(tail);
    if (!method.success) throw agentXError("NOT_FOUND", SIGN_IN_LINK_TEXT.notFound);
    if (!NoBody.safeParse(parsedBody).success) throw agentXError("CONFIG_INVALID", SIGN_IN_LINK_TEXT.invalid);
    okOrRefused(await forward({ kind: "sign-in-unlink", developerId, sessionId, personDeveloperId, method: method.data }) as SignInUnlinkResponse);
    return { removed: true };
  }
  throw agentXError("NOT_FOUND", "route not found");
}

/** The forward through the sign-in Lambda (as the other DeveloperIdentity requests): a fault or a reply that does not read is `unavailable`. */
export function signInLinksThroughLambda(invoke: (payload: Uint8Array) => Promise<{ FunctionError?: string | undefined; Payload?: Uint8Array | undefined }>): SignInLinkForward {
  const unavailable = { ok: false as const, error: "unavailable" as const, message: SIGN_IN_LINK_TEXT.unavailable };
  return async (request) => {
    try {
      const response = await invoke(Buffer.from(JSON.stringify(request)));
      if (response.FunctionError !== undefined || response.Payload === undefined) return unavailable;
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as unknown;
      if (reply === null || typeof reply !== "object" || typeof (reply as { ok?: unknown }).ok !== "boolean") return unavailable;
      return reply as SignInLinkReply;
    } catch { return unavailable; }
  };
}
