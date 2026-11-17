// The in-app inbox's routes on the core host (web task channel C7): `GET /v1/app/inbox` (the caller's own attention rows, newest first, one bounded page with a cursor) and `POST /v1/app/inbox/read` (`{ requestId, ids }`,
// marks only the caller's own rows). Served by the core host only; the legacy engine has no inbox (D6).
//
// The company is the live membership's (the host mounts this per company and checks the principal is that company's); the person is the verified principal's. Nothing about who or which company comes from a query or
// a body. Every row is checked again against the person's session access now (`core/notify/inbox.ts`), so a person who lost access reads nothing. Refusals are fixed words that echo nothing.
import { agentXError } from "@agentx/contracts";
import { listInbox, markInboxRead } from "../core/notify/inbox.js";
import { createSessionAccess, type SessionMembers } from "../core/sessions/access.js";
import { sessionOpenPath } from "../core/decisions/open-path.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { TaskCaller } from "../core/task-flow/deps.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { DocumentStore, OrgId } from "@agentx/contracts";

export const INBOX_PATH = /^\/v1\/app\/inbox(?:\/read)?$/u;
export const INBOX_SIGN_IN_AGAIN = "Sign in again.";
export const INBOX_BAD_REQUEST = "That request is not valid.";
const CURSOR_MAX = 200;

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface InboxRoutesDeps {
  store: Pick<DocumentStore, "get" | "put" | "query" | "update" | "getMany">;
  companyId: OrgId;
  origin: () => string;
  members: SessionMembers;
  now?: () => number;
}

export function createInboxRoutes(deps: InboxRoutesDeps): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const now = deps.now ?? (() => Date.now());
  const access = createSessionAccess({ store: deps.store, members: deps.members });
  return async (request, caller) => {
    const url = new URL(request.path, "http://core");
    if (!INBOX_PATH.test(url.pathname)) return undefined;
    // The host mounts one runtime per company the caller's membership names; a principal of any other company is never served from it.
    if (caller.principal.companyId !== deps.companyId) return json(401, { error: { code: "UNAUTHENTICATED", message: INBOX_SIGN_IN_AGAIN } });
    const who = { companyId: deps.companyId, developerId: developerIdOf(caller.principal) };
    if (url.pathname === "/v1/app/inbox/read") {
      if (request.method !== "POST") return undefined;
      let body: unknown;
      try { body = request.body === undefined || request.body === "" ? undefined : JSON.parse(request.body); } catch { body = undefined; }
      const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
      if (fields === undefined || Object.keys(fields).some((key) => key !== "requestId" && key !== "ids") || typeof fields["requestId"] !== "string" || !REQUEST_ID.test(fields["requestId"]) || !Array.isArray(fields["ids"])) throw agentXError("CONFIG_INVALID", INBOX_BAD_REQUEST);
      return json(200, { marked: await markInboxRead({ store: deps.store, now }, who, fields["ids"] as unknown[]) });
    }
    if (request.method !== "GET") return undefined;
    const limitText = url.searchParams.get("limit");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && cursor.length > CURSOR_MAX) throw agentXError("CONFIG_INVALID", INBOX_BAD_REQUEST);
    const limit = limitText === null ? undefined : /^[0-9]{1,3}$/u.test(limitText) ? Number(limitText) : Number.NaN;
    const page = await listInbox({
      store: deps.store, now,
      link: (sessionId) => `${deps.origin()}${sessionOpenPath(sessionId)}`,
      access: async (session) => { try { const found = await access.of(caller.principal, session, { readOnlyPath: true }); return { owner: found.owner }; } catch { return undefined; } },
    }, who, { limit, cursor });
    return json(200, page);
  };
}
