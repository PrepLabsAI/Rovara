// The People confirmation page (D1-2 review M3, owner DEC 254zzz511). Code's own HTML task page is deleted, but a role or ownership change proposed from an AI tool or a script (the
// core's `people/role` and `people/take-ownership` routes, the MCP tools) still hands a person this link, and confirming it is a human-in-the-loop security step. So this ONE page
// stays, and nothing else of the old task page: `/review/<task>/task/people/confirm/<request>` (GET: the page) and `/review/<task>/task/api/people/requests/<request>` (GET: the
// request's state; POST `.../confirm`: the confirmation). Every request needs the review session; the POST also needs this origin, the CSRF header matching its cookie, a JSON body
// of at most 1 KB and a strict schema. Whoever acts is the session's caller, never anything in the body, and not yours and no such task answer the same 404.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { redactText, type TaskPeopleChangeResult, type TaskPeopleProposal } from "@agentx/contracts";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { TASK_PAGE_STYLE } from "./task-page-assets.js";
import { CSRF_COOKIE, SESSION_COOKIE, csrfCookie, escapeHtml, isCsrfToken, parseCookie, safeResponse, signInLocation, type WebResponse } from "./web-session.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const PEOPLE_CONFIRM_PAGE = new RegExp(`^/review/(${UUID})/task/people/confirm/(${UUID})$`, "i");
export const PEOPLE_CONFIRM_API = new RegExp(`^/review/(${UUID})/task/api/people/requests/(${UUID})(/confirm)?$`, "i");
const BODY_MAX_BYTES = 1024;
const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]);

export interface PeopleConfirmDependencies {
  /** The canonical API origin (or issuer URL); only its origin is used. */
  origin: string;
  /** Resolves an opaque session ID against the revocable developer sign-in store on every request. */
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  getRequest(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
  getMetadata(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleProposal>;
  getPersonName(caller: DeveloperCaller, taskId: string, personId: string): Promise<string | undefined>;
  confirm(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", commenter: "Commenter", viewer: "Viewer", denied: "Removed access" };
const json = (statusCode: number, body: unknown): WebResponse => safeResponse(statusCode, body);

/** A person's name as it reads inside a sentence: one line, redacted, cut short. */
function boundedName(value: string): string {
  const safe = redactText(value).replace(/[\p{Cc}\s]+/gu, " ").trim();
  return Array.from(safe).slice(0, 80).join("") || "Task member";
}

const policy = (nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function htmlResponse(statusCode: number, body: string, nonce: string): WebResponse {
  const response = safeResponse(statusCode, body, nonce);
  response.headers["content-security-policy"] = policy(nonce);
  return response;
}

function messagePage(statusCode: number, heading: string, text: string): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  return htmlResponse(statusCode, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rovara</title>`
    + `<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:40rem;margin:0 auto;padding:2rem 1rem}</style></head>`
    + `<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p></main></body></html>`, nonce);
}

/** The page's one small script (by nonce): the Confirm button posts the request id to this origin and says what came back. Nothing else is sent or read. */
const SCRIPT = String.raw`(function(){
var d=JSON.parse(document.getElementById("agentx-confirm-data").textContent);
var b=document.querySelector("[data-people-confirm]"),s=document.querySelector(".task-people-status");
var say=function(t){s.textContent=t};
b.disabled=false;
b.addEventListener("click",function(){
  b.disabled=true;say("Confirming...");
  fetch("/review/"+d.taskId+"/task/api/people/requests/"+d.requestId+"/confirm",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-agentx-csrf":d.csrf},body:JSON.stringify({requestId:d.requestId})})
    .then(function(r){
      if(r.status===200||r.status===202){say("Done. You can close this page.");return}
      b.disabled=r.status===503;
      say(r.status===409?"This request changed or expired. Ask for a new one.":r.status===403?"This request was refused. Open this page from the same browser you signed in with.":r.status===404?"You can't confirm this request.":"That did not go through. Try again shortly.");
    }).catch(function(){b.disabled=false;say("That did not go through. Try again shortly.")});
});
})();`;

function confirmationPage(view: { taskId: string; requestId: string; expiresAt: string; effect: string }, csrf: string): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  const data = JSON.stringify({ taskId: view.taskId, requestId: view.requestId, csrf }).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return htmlResponse(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Review People change</title>`
    + `<style nonce="${nonce}">${TASK_PAGE_STYLE}</style></head><body><main><section class="task-people-confirmation" aria-labelledby="task-people-confirmation-heading"><h2 id="task-people-confirmation-heading">Review People change</h2>`
    + `<p>${escapeHtml(view.effect)}</p><p>Expires <time datetime="${escapeHtml(view.expiresAt)}">${escapeHtml(view.expiresAt)}</time>.</p>`
    + `<button type="button" data-people-confirm="${escapeHtml(view.requestId)}" disabled>Confirm</button><p>To cancel, close this page.</p><p class="task-people-status" role="status" aria-live="polite"></p></section></main>`
    + `<script type="application/json" id="agentx-confirm-data">${data}</script><script nonce="${nonce}">${SCRIPT}</script></body></html>`, nonce);
}

/** What a refused action answers: the same 404 for not yours and no such task, a 409 for a request that changed, and a retryable 503. */
function refusal(error: unknown): WebResponse {
  const { code } = (error ?? {}) as { code?: unknown };
  if (typeof code === "string" && HIDDEN.has(code)) return json(404, { error: "not_found" });
  if (code === "IDEMPOTENCY_CONFLICT" || code === "CONFIG_INVALID" || code === "TASK_BUSY" || code === "WORKSPACE_BUSY") return json(409, { error: "changed" });
  return json(503, { error: "unavailable" });
}

const COMPLETE = "This People change is already complete.";

/** What the pending request would do, in words, or `complete` when it already did. Reads what the page may show; a request that is not this caller's is refused by the dependencies. */
async function pendingEffect(deps: PeopleConfirmDependencies, caller: DeveloperCaller, taskId: string, requestId: string): Promise<"complete" | { expiresAt: string; effect: string }> {
  if ((await deps.getRequest(caller, taskId, requestId)).status === "COMMITTED") return "complete";
  let proposal: TaskPeopleProposal;
  try { proposal = await deps.getMetadata(caller, taskId, requestId); }
  catch (error) {
    if ((await deps.getRequest(caller, taskId, requestId)).status === "COMMITTED") return "complete";
    throw error;
  }
  if (proposal.kind === "takeOwnership") return { expiresAt: proposal.expiresAt, effect: "Take ownership of this task." };
  const personName = proposal.personId === undefined ? undefined : await deps.getPersonName(caller, taskId, proposal.personId);
  if (proposal.role === undefined || personName === undefined) throw Object.assign(new Error("unavailable"), { code: "RUNTIME_UNAVAILABLE" });
  return { expiresAt: proposal.expiresAt, effect: `Change ${boundedName(personName)} to ${ROLE_LABEL[proposal.role] ?? "a new role"}.` };
}

/** The page: the signed-in person's own pending request, in words, with a Confirm button that does nothing until it is pressed. */
async function servePage(deps: PeopleConfirmDependencies, request: AdaptedHttpRequest, url: URL, caller: DeveloperCaller | undefined, match: RegExpExecArray): Promise<WebResponse> {
  if (request.method.toUpperCase() !== "GET") { const refused = messagePage(405, "Not allowed", "This page is read only."); refused.headers.allow = "GET"; return refused; }
  if (caller === undefined) {
    const redirect = safeResponse(302, "");
    return { ...redirect, headers: { ...redirect.headers, "content-security-policy": policy(""), location: signInLocation(url.pathname) } };
  }
  const taskId = match[1]!.toLowerCase(), requestId = match[2]!.toLowerCase();
  try {
    const pending = await pendingEffect(deps, caller, taskId, requestId);
    if (pending === "complete") return messagePage(200, "People change complete", COMPLETE);
    const current = parseCookie(request.headers, CSRF_COOKIE);
    const csrf = isCsrfToken(current) ? current : randomBytes(32).toString("base64url");
    const response = confirmationPage({ taskId, requestId, ...pending }, csrf);
    response.headers["set-cookie"] = csrfCookie(csrf);
    return response;
  } catch (error) {
    const code = String((error as { code?: unknown })?.code);
    // Not yours, and no such task, read the same: the page never confirms that a task exists.
    if (HIDDEN.has(code)) return messagePage(404, "No access", "You don't have access to this task.");
    return messagePage(503, "Page unavailable", "Rovara couldn't load this right now. Try again shortly.");
  }
}

/** The confirming POST's own checks: this origin, the CSRF header matching its cookie, JSON by its type, at most 1 KB, one strict field naming this request. Undefined: it passes. */
function refusedPost(request: AdaptedHttpRequest, origin: string, requestId: string): WebResponse | undefined {
  const csrf = parseCookie(request.headers, CSRF_COOKIE);
  if (request.headers.origin !== origin || !isCsrfToken(csrf) || request.headers["x-agentx-csrf"] !== csrf) return json(403, { error: "request_refused" });
  if (!/^application\/json\s*(;|$)/i.test((request.headers["content-type"] ?? "").trim())) return json(400, { error: "invalid_request" });
  const body = request.body ?? "";
  if (Buffer.byteLength(body, "utf8") > BODY_MAX_BYTES) return json(400, { error: "invalid_request" });
  let value: unknown;
  try { value = JSON.parse(body); } catch { return json(400, { error: "invalid_request" }); }
  const parsed = z.object({ requestId: z.string().uuid() }).strict().safeParse(value);
  return !parsed.success || parsed.data.requestId.toLowerCase() !== requestId ? json(400, { error: "invalid_request" }) : undefined;
}

async function serveApi(deps: PeopleConfirmDependencies, request: AdaptedHttpRequest, origin: string, caller: DeveloperCaller | undefined, match: RegExpExecArray): Promise<WebResponse> {
  if (caller === undefined) return json(401, { error: "sign_in_required" });
  const taskId = match[1]!.toLowerCase(), requestId = match[2]!.toLowerCase(), confirming = match[3] !== undefined;
  const allowed = confirming ? "POST" : "GET";
  if (request.method.toUpperCase() !== allowed) { const refused = json(405, { error: "method_not_allowed" }); refused.headers.allow = allowed; return refused; }
  try {
    if (!confirming) return json(200, await deps.getRequest(caller, taskId, requestId));
    const refused = refusedPost(request, origin, requestId);
    if (refused !== undefined) return refused;
    const receipt = await deps.getRequest(caller, taskId, requestId);
    if (receipt.status === "COMMITTED") return json(200, receipt);
    const result = await deps.confirm(caller, taskId, requestId);
    return json(result.status === "PENDING" ? 202 : 200, result);
  } catch (error) {
    return refusal(error);
  }
}

export function createPeopleConfirmWeb(deps: PeopleConfirmDependencies): (request: AdaptedHttpRequest, url: URL) => Promise<WebResponse> {
  const origin = new URL(deps.origin).origin;
  return async (request, url) => {
    const page = PEOPLE_CONFIRM_PAGE.exec(url.pathname);
    const api = PEOPLE_CONFIRM_API.exec(url.pathname);
    if (page === null && api === null) return messagePage(404, "Not found", "This page doesn't exist.");
    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    const caller = sessionId === undefined ? undefined : await deps.authenticateSession(sessionId);
    return page !== null ? servePage(deps, request, url, caller, page) : serveApi(deps, request, origin, caller, api!);
  };
}
