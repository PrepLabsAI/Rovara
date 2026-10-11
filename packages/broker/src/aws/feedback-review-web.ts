import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import {
  CSRF_COOKIE, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, canonicalGithubUrl, escapeHtml as escape, parseCookie, safeResponse, safeText,
  signInLocation as signInTo,
} from "./web-session.js";

export { reviewSessionCookie, reviewSessionCookieName } from "./web-session.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DecisionSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bundleDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(32),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "DISMISS"]),
  selectedFindingIds: z.array(z.string().min(1).max(160)).max(128),
  ownerNote: z.string().trim().min(1).max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.bundleDigests).size !== value.bundleDigests.length
    || new Set(value.selectedFindingIds).size !== value.selectedFindingIds.length
    || (value.decision === "APPROVE" && value.selectedFindingIds.length === 0)
    || (value.decision !== "APPROVE" && value.ownerNote === undefined)
    || (value.decision !== "APPROVE" && value.selectedFindingIds.length > 0)) {
    context.addIssue({ code: "custom", message: "decision selection or reason is invalid" });
  }
});

export interface FeedbackReviewWebDependencies {
  /** Canonical API origin, without a trailing slash. */
  origin: string;
  /** Resolves an opaque session ID against the revocable developer sign-in store on every request. */
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  /** The implementation must load the canonical task through the broker and enforce exact owner policy. */
  getWorkflowFeedbackReview(caller: DeveloperCaller, taskId: string): Promise<Record<string, unknown>>;
  /** The implementation must re-read and conditionally update the task through the broker. */
  submitWorkflowFeedbackDecision(caller: DeveloperCaller, taskId: string, input: z.infer<typeof DecisionSchema>): Promise<unknown>;
  now(): number;
}

export interface FeedbackReviewWebResponse { statusCode: number; headers: Record<string, string>; body: string }

const scriptJson = (value: unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({
  "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029",
})[character]!);
const isCsrf = (value: string | undefined): value is string => value !== undefined && /^[A-Za-z0-9_-]{32,64}$/.test(value);
const signInLocation = (taskId: string) => signInTo(`/review/${taskId}`);

function page(review: Record<string, unknown>, csrf: string, nonce: string): string {
  const pending = review.status === "PENDING" && (review.workflowStatus === undefined
    || (review.workflowStatus === "WAITING" && review.workflowStage === "WAIT_FOR_MERGE"));
  const findings = Array.isArray(review.findings) ? review.findings as Array<Record<string, unknown>> : [];
  const recommendedIds = Array.isArray(review.recommendedFindingIds) ? review.recommendedFindingIds.filter((id): id is string => typeof id === "string") : [];
  const candidates = Array.isArray(review.candidates) ? review.candidates as Array<Record<string, unknown>> : [];
  const highest = findings.find(finding => finding.priority === "MUST_FIX") ?? findings[0];
  const actionable = findings.filter(finding => finding.recommended === true).length;
  const originalCommentCount = new Set(findings.flatMap(finding => Array.isArray(finding.commentIds) ? finding.commentIds.map(String) : [])).size;
  const id = safeText(review.taskId);
  const findingCards = findings.map((finding, index) => {
    const findingId = safeText(finding.id, `finding-${index + 1}`);
    const comments = Array.isArray(finding.comments) ? finding.comments as Array<Record<string, unknown>> : [];
    const commentContent = comments.map(comment => {
      const sourceUrl = canonicalGithubUrl(comment.url);
      return `<li><p>${escape(comment.body)}</p>${sourceUrl ? `<p><a href="${escape(sourceUrl)}" rel="noreferrer">View original GitHub comment</a></p>` : ""}<p>By ${escape(comment.author)}${comment.path ? ` · ${escape(comment.path)}${comment.line ? `:${escape(comment.line)}` : ""}` : ""}</p></li>`;
    }).join("");
    const recommended = recommendedIds.includes(findingId);
    const selection = pending ? `<label><input class="finding-choice" type="checkbox" value="${escape(findingId)}" ${recommended ? "checked" : ""}> Include this finding</label>` : "";
    const proposal = finding.fixProposal !== null && typeof finding.fixProposal === "object" ? finding.fixProposal as Record<string, unknown> : undefined;
    const fileChanges = Array.isArray(proposal?.fileChanges) ? proposal.fileChanges as Array<Record<string, unknown>> : [];
    const tests = Array.isArray(proposal?.tests) ? proposal.tests as Array<Record<string, unknown>> : [];
    const proposalContent = proposal === undefined ? "" : `<section aria-label="Proposed fix"><h4>Proposed fix</h4><p>${escape(proposal.summary)}</p><h5>Files</h5><ul>${fileChanges.map(change => `<li>${escape(change.operation)} <code>${escape(change.repositoryId)}/${escape(change.path)}</code>: ${escape(change.change)}</li>`).join("")}</ul><h5>Tests</h5><ul>${tests.map(test => `<li>${escape(test.operation)} <code>${escape(test.repositoryId)}/${escape(test.path)}</code>: ${escape(test.behavior)}</li>`).join("")}</ul></section>`;
    return `<article class="finding"><h3>${escape(finding.priority)} · ${escape(finding.assessment)}</h3><p>${escape(finding.rationale)}</p><p class="muted">${recommended ? "AgentX recommends addressing this." : "AgentX does not recommend a code change for this item."}</p>${selection}<details><summary>See proposed fix, comments and evidence</summary>${proposalContent}<p>${escape(finding.confidence && typeof finding.confidence === "object" ? (finding.confidence as Record<string, unknown>).reason : "")}</p><ul>${commentContent}</ul><ul>${(Array.isArray(finding.evidence) ? finding.evidence as Array<Record<string, unknown>> : []).map(evidence => `<li>${escape(evidence.source)}: ${escape(evidence.reference)}</li>`).join("")}</ul></details></article>`;
  }).join("");
  const prList = candidates.map(pr => `<li>${escape(pr.repositoryId)} #${escape(pr.number)} · head <code>${escape(pr.headSha)}</code></li>`).join("");
  const checks = (Array.isArray(review.checks) ? review.checks : []).map(check => `<li>${escape(check)}</li>`).join("");
  const highestText = highest ? `${escape(highest.priority)}: ${escape(highest.rationale)}` : "No findings are ready for a recommendation.";
  const decision = review.decision && typeof review.decision === "object" ? review.decision as Record<string, unknown> : undefined;
  const recordedDecision = decision?.decision === "APPROVE" ? "Approved" : decision?.decision === "REQUEST_CHANGES" ? "Changes requested" : decision?.decision === "DISMISS" ? "Dismissed" : undefined;
  const nextAction = typeof review.nextAction === "string" ? review.nextAction
    : decision?.nextAction === "implementation" ? "AgentX will continue with implementation and the selected checks."
    : decision?.decision === "REQUEST_CHANGES" ? "AgentX is waiting for your updated instructions."
    : "No code changes will start from this proposal.";
  const workflowStatus = safeText(review.workflowStatus, "UNKNOWN");
  const workflowStage = safeText(review.workflowStage, "UNKNOWN");
  const operationStatus = review.activeOperation && typeof review.activeOperation === "object"
    ? safeText((review.activeOperation as Record<string, unknown>).status, "UNKNOWN") : "None active";
  const operationKind = review.activeOperation && typeof review.activeOperation === "object"
    ? safeText((review.activeOperation as Record<string, unknown>).kind, "operation") : undefined;
  const currentStatus = `<section aria-label="Current workflow status"><h2>Current workflow status: ${escape(workflowStatus)}</h2><p>Current stage: ${escape(workflowStage)}</p><p>Current operation status: ${escape(operationStatus)}${operationKind ? ` (${escape(operationKind)})` : ""}</p>${review.blockReason ? `<p><strong>Blocker:</strong> ${escape(review.blockReason)}</p>` : ""}<p><strong>Next action:</strong> ${escape(nextAction)}</p></section>`;
  const outcome = !pending && recordedDecision !== undefined
    ? `<section aria-label="Recorded decision"><h2>Decision recorded: ${recordedDecision}</h2>${decision?.ownerNote ? `<p>Your note: ${escape(decision.ownerNote)}</p>` : ""}<p class="muted">Recorded ${escape(decision?.at)}</p></section>`
    : "";
  const recommendedButton = recommendedIds.length > 0 ? `<button type="button" id="approve-recommended">Approve recommended fixes</button>` : "";
  const recommendedHandler = recommendedIds.length > 0
    ? `document.querySelector('#approve-recommended').addEventListener('click',()=>{document.querySelectorAll('.finding-choice').forEach(x=>x.checked=${scriptJson(recommendedIds)}.includes(x.value));send('APPROVE',${scriptJson(recommendedIds)})});`
    : "";
  const reviewControls = pending
    ? `${currentStatus}<p>This is AI guidance, not independent evidence. Reviewers’ comments stay visible. Only your explicit approval starts the selected code changes.</p><p><strong>${originalCommentCount} ${originalCommentCount === 1 ? "comment" : "comments"} grouped into ${findings.length} findings.</strong> AgentX recommends addressing ${actionable}.</p><section aria-labelledby="recommendation"><h2 id="recommendation">AgentX recommends</h2><p>${highestText}</p><p>Approving starts the selected code changes and checks. It does not reply to GitHub, merge, or deploy.</p></section><form id="decision"><input type="hidden" name="csrf" value="${csrf}"><section><h2>Choose findings</h2>${findingCards}<p>${recommendedButton}<button type="submit" id="approve-selected">Approve selected findings</button></p></section><section><h2>Another decision</h2><label for="owner-note">Note for AgentX</label><textarea id="owner-note" name="ownerNote" maxlength="2000"></textarea><p><button type="button" id="request-changes">Request changes</button><button type="button" id="dismiss">Dismiss proposal</button></p></section><p id="status" role="status" aria-live="polite"></p></form>`
    : `${currentStatus}${outcome}<p>This AI-generated advisory and the owner’s decision are retained in the private AgentX task record.</p><p><strong>${originalCommentCount} ${originalCommentCount === 1 ? "comment" : "comments"} grouped into ${findings.length} findings.</strong></p><section><h2>Review details</h2>${findingCards}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PR feedback · ${escape(review.title)}</title><style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:52rem;margin:0 auto;padding:clamp(1rem,4vw,2.5rem);line-height:1.55}h1,h2,h3{line-height:1.2}.muted{opacity:.8}.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:.12rem .6rem;font-size:.85rem}.finding{border-top:1px solid #888;padding:1rem 0}button{font:inherit;padding:.65rem 1rem;margin:.35rem;border-radius:.35rem;cursor:pointer}textarea{display:block;width:min(100%,40rem);min-height:5rem;font:inherit}a:focus,button:focus,input:focus,textarea:focus,summary:focus{outline:3px solid #478cff;outline-offset:2px}@media(max-width:35rem){body{padding:1rem}code{overflow-wrap:anywhere}}</style></head><body><main><p class="badge">AI-generated advisory</p><h1>${escape(review.title ?? "PR feedback review")}</h1>${reviewControls}<section><h2>Pull requests</h2><ul>${prList}</ul><h2>Checks to run</h2><ul>${checks}</ul></section></main>${pending ? `<script nonce="${nonce}">(()=>{const form=document.querySelector('#decision');const status=document.querySelector('#status');const choices=()=>Array.from(document.querySelectorAll('.finding-choice:checked')).map(x=>x.value);async function send(decision,selected){const data={requestId:crypto.randomUUID(),expectedRevision:${Number(review.revision) || 0},reviewDigest:${scriptJson(safeText(review.reviewDigest))},proposalDigest:${scriptJson(safeText(review.proposalDigest))},bundleDigests:${scriptJson(Array.isArray(review.bundleDigests) ? review.bundleDigests : [])},decision,selectedFindingIds:selected,...(document.querySelector('#owner-note').value.trim()?{ownerNote:document.querySelector('#owner-note').value.trim()}: {})};status.textContent='Sending your decision…';const response=await fetch('/review/${encodeURIComponent(id)}/api/decision',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-agentx-csrf':${scriptJson(csrf)}},body:JSON.stringify(data)});const result=await response.json();status.textContent=response.ok?'Decision recorded. AgentX will show the next step here.':(result.message||'The review changed. Refresh the page before deciding.');if(response.ok)location.reload()}${recommendedHandler}form.addEventListener('submit',event=>{event.preventDefault();send('APPROVE',choices())});document.querySelector('#request-changes').addEventListener('click',()=>send('REQUEST_CHANGES',[]));document.querySelector('#dismiss').addEventListener('click',()=>send('DISMISS',[]))})();</script>` : ""}</body></html>`;
}

/** Same-origin private page and API. The caller and task owner are revalidated for every request. */
export function createFeedbackReviewWeb(deps: FeedbackReviewWebDependencies) {
  const origin = new URL(deps.origin).origin;
  return async (request: AdaptedHttpRequest, url: URL): Promise<FeedbackReviewWebResponse> => {
    const route = /^\/review\/([^/]+)(?:\/(api|api\/decision))?$/.exec(url.pathname);
    const taskId = route?.[1];
    if (taskId === undefined || !TASK_ID.test(taskId)) return safeResponse(404, { error: "not_found" });
    const endpoint = route?.[2];
    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    if (sessionId === undefined) {
      if (request.method !== "GET" || endpoint !== undefined) return safeResponse(401, { error: "sign_in_required" });
      return { ...safeResponse(302, ""), headers: { ...safeResponse(302, "").headers, location: signInLocation(taskId) } };
    }
    const caller = await deps.authenticateSession(sessionId);
    if (caller === undefined) return safeResponse(401, { error: "sign_in_required" });
    if (endpoint === "api/decision") {
      if (request.method !== "POST") return safeResponse(405, { error: "method_not_allowed" });
      const csrfCookie = parseCookie(request.headers, CSRF_COOKIE);
      if (request.headers.origin !== origin || !isCsrf(csrfCookie) || request.headers["x-agentx-csrf"] !== csrfCookie) return safeResponse(403, { error: "request_refused" });
      let input: unknown;
      try { input = JSON.parse(request.body ?? ""); } catch { return safeResponse(400, { error: "invalid_request" }); }
      const parsed = DecisionSchema.safeParse(input);
      if (!parsed.success) return safeResponse(400, { error: "invalid_request" });
      try {
        return safeResponse(200, await deps.submitWorkflowFeedbackDecision(caller, taskId, parsed.data));
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const statusCode = code === "FORBIDDEN" || code === "TASK_NOT_FOUND" || code === "NOT_FOUND" ? 404 : 409;
        return safeResponse(statusCode, { error: statusCode === 404 ? "not_found" : "review_changed", message: statusCode === 404 ? "Review not found." : "This review changed. Refresh it before deciding." });
      }
    }
    if (endpoint !== undefined && request.method !== "GET") return safeResponse(405, { error: "method_not_allowed" });
    try {
      const review = await deps.getWorkflowFeedbackReview(caller, taskId);
      if (endpoint === "api") return safeResponse(200, review);
      const currentCsrf = parseCookie(request.headers, CSRF_COOKIE);
      const pending = review.status === "PENDING";
      const csrf = pending ? (isCsrf(currentCsrf) ? currentCsrf : randomBytes(32).toString("base64url")) : "";
      const nonce = randomBytes(18).toString("base64url");
      const response: FeedbackReviewWebResponse = safeResponse(200, page(review, csrf, nonce), nonce);
      if (pending && !isCsrf(currentCsrf)) response.headers["set-cookie"] = `${CSRF_COOKIE}=${csrf}; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
      return response;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const hidden = code === "FORBIDDEN" || code === "TASK_NOT_FOUND" || code === "NOT_FOUND";
      return safeResponse(hidden ? 404 : 503, { error: hidden ? "not_found" : "review_unavailable" });
    }
  };
}
