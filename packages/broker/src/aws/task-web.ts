// Task 18 (gap 4): the read-only AgentX task page. A brief Slack message links here for the full document; the page
// shows the task's current documents, where it stands, its checks, the current code's review findings, its pull
// requests and the thread's replies. GET only, no script, no forms. Every value is escaped; model and reviewer text is
// plain text in the page, so a link in it is never a link.
import { randomBytes } from "node:crypto";
import { redactText } from "@agentx/contracts";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { SESSION_COOKIE, canonicalGithubUrl, escapeHtml, parseCookie, safeResponse, signInLocation, type WebResponse } from "./web-session.js";

export type TaskDocumentKind = "requirements" | "design" | "coding plan";

export interface TaskDocumentView {
  taskId: string;
  title: string;
  /** Where the task stands, in plain words. */
  status: string;
  nextStep: string;
  documents: Array<{ kind: TaskDocumentKind; version: number; markdown: string; approved: boolean }>;
  /** Documents whose saved copy failed its check: named, never shown. */
  unverified?: TaskDocumentKind[];
  /** `unclear`: the check ran but its result couldn't be told. */
  checks: Array<{ label: string; passed: boolean | undefined; unclear?: true }>;
  /** The current code's review findings. */
  findings: Array<{ role: "code" | "security"; text: string; origin: "INTRODUCED" | "PRE_EXISTING"; file?: string; line?: number }>;
  pullRequests: Array<{ url: string; number: number; state: string }>;
  replies: Array<{ author: "owner" | "teammate"; text: string; at: string }>;
}

export interface TaskWebDependencies {
  /** Resolves an opaque session ID against the revocable developer sign-in store on every request. */
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  /** Must load the task through the broker and refuse (TASK_NOT_FOUND) a reader who may not see it. */
  getTaskDocumentView(caller: DeveloperCaller, taskId: string): Promise<TaskDocumentView>;
}

/** `/review/<task ID>/task`: the task page's path; every other `/review/` path is not found. */
export const TASK_PAGE = /^\/review\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/task$/i;
const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "NOT_FOUND"]);

/** This page's policy: its one style element, and nothing else; no script runs and nothing is submitted. */
const policy = (nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'none'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/**
 * A reviewer's file path, shown only when it is a plain relative path inside the repository: no leading slash or
 * drive, no `..`, no scheme, no backslash or control characters. Redacted first.
 */
export function safeFindingPath(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const path = redactText(file).trim();
  if (path === "" || path.length > 300 || path !== file.trim()) return undefined;
  if (!/^[A-Za-z0-9._@+\-/ ]+$/.test(path) || path.startsWith("/") || path.includes("//")) return undefined;
  return path.split("/").some((segment) => segment === ".." || segment === "." || segment === "") ? undefined : path;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const PULL_REQUEST_STATES: Record<string, string> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
const checkWords = (check: TaskDocumentView["checks"][number]) => (check.passed === true ? "Passed" : check.passed === false ? "Didn't pass" : check.unclear === true ? "Couldn't tell" : "Not run yet");
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function findingItem(finding: TaskDocumentView["findings"][number]): string {
  const file = safeFindingPath(finding.file);
  const where = file === undefined ? "" : ` <code>${escapeHtml(file)}${finding.line === undefined ? "" : `:${escapeHtml(finding.line)}`}</code>`;
  return `<li><span class="tag">${finding.role === "security" ? "Security review" : "Code review"}</span> ${escapeHtml(finding.text)}${where}</li>`;
}

function page(view: TaskDocumentView, nonce: string): string {
  const documents = view.documents.map((document) => `<section aria-label="${escapeHtml(capitalized(document.kind))}"><h2>${escapeHtml(capitalized(document.kind))} v${escapeHtml(document.version)}</h2>`
    + `<p class="muted">${document.approved ? "Approved" : "Not approved yet"}</p><pre class="doc">${escapeHtml(document.markdown)}</pre></section>`).join("");
  const unverified = (view.unverified ?? []).map((kind) => `<p><strong>The saved ${escapeHtml(kind)} couldn't be verified, so it isn't shown.</strong></p>`).join("");
  const noDocuments = view.documents.length === 0 && unverified === "" ? "<p class=\"muted\">No document has been written yet.</p>" : "";
  const checks = view.checks.length === 0 ? "<p class=\"muted\">No checks are set up for this task.</p>"
    : `<ul>${view.checks.map((check) => `<li>${escapeHtml(check.label)}: ${checkWords(check)}</li>`).join("")}</ul>`;
  const introduced = view.findings.filter((finding) => finding.origin === "INTRODUCED");
  const older = view.findings.filter((finding) => finding.origin === "PRE_EXISTING");
  const findings = view.findings.length === 0 ? "<p class=\"muted\">No review findings for the current code.</p>"
    : `<h3>Caused by this change</h3>${introduced.length === 0 ? "<p class=\"muted\">None.</p>" : `<ul>${introduced.map(findingItem).join("")}</ul>`}`
      + `<h3>Already in the code (advisory)</h3>${older.length === 0 ? "<p class=\"muted\">None.</p>" : `<ul>${older.map(findingItem).join("")}</ul>`}`;
  const pullRequests = view.pullRequests.length === 0 ? "<p class=\"muted\">No pull request yet.</p>"
    : `<ul>${view.pullRequests.map((pullRequest) => {
      const url = canonicalGithubUrl(pullRequest.url);
      const name = `Pull request #${escapeHtml(pullRequest.number)}`;
      return `<li>${url === undefined ? name : `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow">${name}</a>`}: ${PULL_REQUEST_STATES[pullRequest.state] ?? "status not known yet"}</li>`;
    }).join("")}</ul>`;
  const replies = view.replies.length === 0 ? "<p class=\"muted\">No thread replies.</p>"
    : `<ul>${view.replies.map((reply) => `<li><span class="tag">${reply.author === "owner" ? "Task owner" : "Teammate"}</span> <span class="muted">${escapeHtml(reply.at)}</span><p>${escapeHtml(reply.text)}</p></li>`).join("")}</ul>`;
  const style = ":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:52rem;margin:0 auto;padding:clamp(1rem,4vw,2.5rem);line-height:1.55}"
    + "h1,h2,h3{line-height:1.2}.muted{opacity:.8}.tag{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 .5rem;font-size:.85rem}"
    + "pre.doc{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace;border-left:3px solid #888;padding:.5rem 1rem}"
    + "section{border-top:1px solid #888;padding:.5rem 0}a:focus{outline:3px solid #478cff;outline-offset:2px}@media(max-width:35rem){body{padding:1rem}code{overflow-wrap:anywhere}}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentX task · ${escapeHtml(view.title)}</title>`
    + `<style nonce="${nonce}">${style}</style></head><body><main><h1>${escapeHtml(view.title)}</h1>`
    + `<section aria-label="Where this task stands"><p><strong>${escapeHtml(view.status)}</strong></p><p>Next: ${escapeHtml(view.nextStep)}</p><p class="muted">Read only. Decisions are made in Slack.</p></section>`
    + `${unverified}${documents}${noDocuments}`
    + `<section aria-label="Checks"><h2>Checks</h2>${checks}</section>`
    + `<section id="findings" aria-label="Review findings"><h2>Review findings</h2>${findings}</section>`
    + `<section aria-label="Pull requests"><h2>Pull requests</h2>${pullRequests}</section>`
    + `<section aria-label="Thread replies"><h2>Thread replies</h2><p>${plural(view.replies.length, "thread reply", "thread replies")}</p>${replies}</section>`
    + "</main></body></html>";
}

function htmlResponse(statusCode: number, body: string, nonce: string): WebResponse {
  const response = safeResponse(statusCode, body, nonce);
  response.headers["content-security-policy"] = policy(nonce);
  return response;
}

function messagePage(statusCode: number, heading: string, text: string): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  return htmlResponse(statusCode, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentX</title>`
    + `<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:40rem;margin:0 auto;padding:2rem 1rem}</style></head>`
    + `<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p></main></body></html>`, nonce);
}

/** The read-only task page. The session and the reader's right to see the task are checked on every request. */
export function createTaskWeb(deps: TaskWebDependencies): (request: AdaptedHttpRequest, url: URL) => Promise<WebResponse> {
  return async (request, url) => {
    const taskId = TASK_PAGE.exec(url.pathname)?.[1];
    if (taskId === undefined) return messagePage(404, "Not found", "This page doesn't exist.");
    if (request.method !== "GET") {
      const refused = messagePage(405, "Not allowed", "This page is read only.");
      refused.headers.allow = "GET";
      return refused;
    }
    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    const caller = sessionId === undefined ? undefined : await deps.authenticateSession(sessionId);
    if (caller === undefined) {
      const redirect = safeResponse(302, "");
      return { ...redirect, headers: { ...redirect.headers, "content-security-policy": policy(""), location: signInLocation(`/review/${taskId}/task`) } };
    }
    try {
      const view = await deps.getTaskDocumentView(caller, taskId);
      const nonce = randomBytes(18).toString("base64url");
      return htmlResponse(200, page(view, nonce), nonce);
    } catch (error) {
      // Not yours, and no such task, read the same: the page never confirms that a task exists.
      if (HIDDEN.has(String((error as { code?: unknown })?.code))) return messagePage(404, "Task not found", "There's no task here that you can see. Open it from its Slack thread.");
      return messagePage(503, "Task page unavailable", "AgentX couldn't load this task right now. Try again shortly.");
    }
  };
}
