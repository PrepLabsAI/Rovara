// Lane L8: the five pages, as pure functions from a view model to HTML. A page that takes a decision draws its form with a form token that binds the
// exact content shown; the server checks that binding again when the form comes back.
import { randomUUID } from "node:crypto";
import { SCRIPT_TOKEN_DEFAULT_DAYS, SCRIPT_TOKEN_MAX_DAYS, SCRIPT_TOKEN_NAME_MAX, SCRIPT_TOKEN_PERMISSIONS, type CreatedScriptToken, type PlanDocumentKind } from "@agentx/contracts";
import { renderPlanDocument, type PlanAnchor } from "../../aws/plan-page/render-plan.js";
import { esc, externalLink, layout, untrusted } from "./html.js";
import type { FormBinding } from "./guard.js";
import { PART_STATE_WORDS } from "../work-breakdown/view.js";
import type {
  ApprovalOffer, CommentView, DesignReviewView, LessonView, PendingItemView, PlanPageView, PlanVersionView, ProofReportView, ScriptTokensPageView,
} from "./views.js";
import type { SecondReviewState } from "@agentx/contracts";

/** What every page needs from the server that draws it. */
export interface PageContext {
  /** `/s/<token>`: where this session's pages live. Only ever used in links and forms. */
  base: string;
  nonce: string;
  sessionId: string;
  /** Signs a form: the token binds the session and what the form is about. */
  formToken(binding: Omit<FormBinding, "sessionId">): string;
  /** A sentence to show at the top (the outcome of the last write). */
  notice?: string;
}

const ANCHOR_OF: Record<PlanVersionView["kind"], PlanAnchor> = { requirements: "requirements", design: "design", "coding plan": "coding-plan" };
const PLAN_KIND_OF: Record<PlanVersionView["kind"], PlanDocumentKind> = { requirements: "requirements", design: "design", "coding plan": "plan" };
const STATUS_CLASS = { passed: "ok", failed: "bad", not_run: "warn", proposed: "muted" } as const;
const STATUS_WORD = { passed: "passed", failed: "failed", not_run: "not run", proposed: "proposed" } as const;

const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

function approvalFields(context: PageContext, action: string, taskId: string, offer: ApprovalOffer): string {
  return [
    hidden("requestId", offer.requestId), hidden("revision", offer.revision), hidden("digest", offer.artifactDigest),
    hidden("ft", context.formToken({ action, taskId, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })),
  ].join("");
}

// ---- Waiting for you

export function renderIndex(context: PageContext, items: readonly PendingItemView[]): string {
  const rows = items.map((item) => `<li><a href="${esc(context.base)}/${item.kind === "plan" ? "plan" : "design"}/${esc(item.taskId)}">${untrusted(item.title)}</a> <span class="tag">${item.kind === "plan" ? "plan" : "design"}</span> <span class="muted">since ${esc(item.since)}</span></li>`);
  return layout({
    title: "Waiting for you", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Waiting for you</h1>${rows.length === 0 ? "<p class=\"muted\">Nothing is waiting for you.</p>" : `<ul>${rows.join("")}</ul>`}`,
  });
}

// ---- the plan

function commentsHtml(context: PageContext, view: PlanPageView): string {
  const list = (comments: readonly CommentView[]) => comments.map((comment) => `<li id="comment-${esc(comment.id)}"><strong>${untrusted(comment.author)}</strong> <span class="muted">${esc(comment.at)}${comment.target === "" ? "" : ` on ${untrusted(comment.target)}`}</span><br>${untrusted(comment.text)}</li>`).join("");
  const form = `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/comment">`
    + `<label>Comment on the plan, or on one claim<br><input type="text" name="target" maxlength="40" placeholder="claim number such as 2.1, or leave empty" autocomplete="off"></label>`
    + "<label>Your comment<br><textarea name=\"text\" maxlength=\"4000\" required></textarea></label>"
    + `${hidden("ft", context.formToken({ action: "plan.comment", taskId: view.taskId, revision: view.revision }))}${hidden("revision", view.revision)}`
    + "<div class=\"row\"><button type=\"submit\">Add comment</button></div></form>";
  return `<section class="panel" id="comments"><h2>Comments</h2>${view.comments.length === 0 ? "<p class=\"muted\">No comments yet.</p>" : `<ul>${list(view.comments)}</ul>`}${form}</section>`;
}

/** What a second model made of the coding plan: Rovara's words, and the second model's points drawn as untrusted. */
function critiqueHtml(view: PlanPageView): string {
  if (view.critique === undefined || view.critique.length === 0) return "";
  return `<section class="panel" id="critique"><h2>A second model's check</h2><ul>${view.critique.map((line) => `<li>${untrusted(line)}</li>`).join("")}</ul></section>`;
}

/** One fieldset for each decision of the plan that waits: its options as radios, AgentX's recommendation chosen, so approving as it stands answers each one with the recommendation. The text is the model's: drawn as untrusted. */
function decisionFields(view: PlanPageView): string {
  const waiting = view.versions.find((version) => version.current && version.content.format === "structured");
  if (waiting === undefined || waiting.content.format !== "structured") return "";
  return waiting.content.plan.decisions.map((decision) => `<fieldset><legend>${untrusted(decision.question)}</legend>${decision.options.map((option) =>
    `<label><input type="radio" name="answer-${esc(decision.id)}" value="${esc(option.id)}"${option.id === decision.recommended ? " checked" : ""}> ${untrusted(option.label)}${option.id === decision.recommended ? " <span class=\"tag\">recommended</span>" : ""}`
    + `<br><span class="muted">${untrusted(option.consequence)}</span></label>`).join("")}</fieldset>`).join("");
}

function decideHtml(context: PageContext, view: PlanPageView): string {
  const offer = view.approval;
  if (offer === undefined) return "";
  return `<section class="panel" id="decide"><h2>Your decision</h2>`
    + `<p>You are deciding revision ${esc(offer.revision)} of this plan. If it changes before you press a button, nothing is sent and you are asked to look again.</p>`
    + `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/decide">${approvalFields(context, "plan.decide", view.taskId, offer)}${decisionFields(view)}`
    + "<label>What to change (needed if you ask for changes)<br><textarea name=\"note\" maxlength=\"4000\"></textarea></label>"
    + "<div class=\"row\"><button class=\"primary\" type=\"submit\" name=\"decision\" value=\"approve\">Approve this plan</button>"
    + "<button type=\"submit\" name=\"decision\" value=\"changes\">Ask for changes</button></div></form></section>";
}

/** Rovara's ask, the merge state and Understand's questions, in fixed words, with the forms that answer them (Retry; the answers). */
function attentionHtml(context: PageContext, view: PlanPageView): string {
  const attention = view.attention;
  if (attention === undefined) return "";
  const parts: string[] = [];
  if (attention.ask !== undefined) {
    const retry = attention.ask.retry
      ? `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/retry">${hidden("revision", view.revision)}${hidden("ft", context.formToken({ action: "task.retry", taskId: view.taskId, revision: view.revision }))}`
        + "<div class=\"row\"><button class=\"primary\" type=\"submit\">Retry</button></div></form>"
      : "";
    parts.push(`<section class="panel" id="ask"><h2>Rovara asks</h2>${attention.ask.lines.map((line) => `<p>${untrusted(line)}</p>`).join("")}${retry}</section>`);
  }
  if (attention.thread !== undefined) {
    const t = attention.thread;
    const current = t.attached === undefined ? "<p class=\"muted\">No thread is attached. A plan is decided on this page.</p>" : `<p>A writer's <code>/rovara approve</code> on ${untrusted(t.attached.repository)} #${esc(t.attached.number)} can decide this plan. Rovara posts the version that waits there.</p>`;
    const form = `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/thread">${hidden("revision", view.revision)}${hidden("ft", context.formToken({ action: "task.thread", taskId: view.taskId, revision: view.revision }))}`
      + `<label>Repository<br><select name="repository">${t.repositories.map((name) => `<option value="${esc(name)}">${untrusted(name)}</option>`).join("")}</select></label>`
      + "<label>Issue or pull request number<br><input type=\"number\" name=\"number\" min=\"1\" required></label><div class=\"row\"><button type=\"submit\">Attach this thread</button></div></form>";
    parts.push(`<section class="panel" id="thread"><h2>Where the plan is posted</h2>${current}${form}</section>`);
  }
  if (attention.questions !== undefined) {
    const fields = attention.questions.items.map((item) => {
      const options = item.options.length === 0 ? "" : item.options.map((option) => `<label><input type="radio" name="option-${esc(item.id)}" value="${esc(option.id)}"> ${untrusted(option.label)}</label>`).join(" ");
      return `<fieldset><legend>${untrusted(item.text)}</legend>${options}<label>${item.options.length === 0 ? "Your answer" : "Or say it in your own words"}<br><textarea name="text-${esc(item.id)}" maxlength="1000"></textarea></label></fieldset>`;
    }).join("");
    parts.push(`<section class="panel" id="questions"><h2>Rovara has questions</h2><form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/answers">${hidden("revision", view.revision)}${hidden("round", attention.questions.round)}`
      + `${hidden("ft", context.formToken({ action: "task.answers", taskId: view.taskId, revision: view.revision }))}${fields}<div class="row"><button class="primary" type="submit">Send my answers</button></div></form></section>`);
  }
  if (attention.merge !== undefined) parts.push(`<section class="panel" id="merge"><h2>The pull request</h2><ul>${attention.merge.lines.map((line) => `<li>${untrusted(line)}</li>`).join("")}</ul></section>`);
  return parts.join("");
}

/** The parts of an ordered run, in the order they run, each with where it stands. Titles are the plan's words (untrusted); the state words are Rovara's. */
function breakdownHtml(view: NonNullable<PlanPageView["breakdown"]>): string {
  const rows = view.parts.map((part) => `<li><span class="status ${part.state === "done" ? "approved" : "pending"}">${esc(PART_STATE_WORDS[part.state])}</span> ${untrusted(part.title)}${part.waitsFor.length === 0 ? "" : ` <span class="muted">after ${part.waitsFor.map((title) => untrusted(title)).join(", ")}</span>`}</li>`).join("");
  const how = view.atOnce === undefined ? "One part at a time, in this order." : `Up to ${esc(view.atOnce)} parts at a time; a part waits for the parts it follows.`;
  return `<section class="panel"><h2>Work in parts</h2><p class="muted">${esc(how)}${view.approved ? " The plan's approval covers these parts." : ""}</p><ol>${rows}</ol></section>`;
}

/** The second review of this code: its lines, and the owner's acknowledgement when an `on` review did not run (the merge waits for it). */
function secondReviewHtml(context: PageContext, view: PlanPageView): string {
  const second = view.secondReview;
  if (second === undefined) return "";
  const lines = second.lines.map((line) => `<p>${untrusted(line)}</p>`).join("");
  const ask = second.needsAcknowledgement && !second.acknowledged && view.secondReviewAck !== undefined
    ? `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/second-review-acknowledge">${hidden("revision", view.revision)}${hidden("key", view.secondReviewAck)}`
      + `${hidden("ft", context.formToken({ action: "second-review.acknowledge", taskId: view.taskId, revision: view.revision, subject: view.secondReviewAck }))}`
      + "<div class=\"row\"><button class=\"primary\" type=\"submit\">Acknowledge: I have seen this</button></div></form>"
    : second.acknowledged ? "<p class=\"muted\">You acknowledged this.</p>" : "";
  const note = ask === "" ? "" : "<p class=\"muted\">Where Rovara holds a merge for this, acknowledging releases it. Rovara does not merge on this computer: check the second-review line on the pull request before you merge.</p>";
  return `<section class="panel" id="second-review"><h2>Second review</h2>${lines}${note}${ask}</section>`;
}

/** The line that says a design's review did not run (fixed words), in front of the approval form. */
function designNoteHtml(view: PlanPageView): string {
  return view.designNote === undefined ? "" : `<p class="panel" id="design-not-run"><strong>${esc(view.designNote)}</strong></p>`;
}

export async function renderPlanPage(context: PageContext, view: PlanPageView): Promise<string> {
  const current = view.versions.filter((version) => version.current);
  const older = view.versions.filter((version) => !version.current);
  const currentVersionOf = (kind: PlanVersionView["kind"]) => view.versions.find((version) => version.kind === kind && version.current)?.version;
  const one = async (version: PlanVersionView): Promise<string> => {
    if (version.content.format === "markdown") {
      return `<section class="doc"><h2>${esc(version.kind)} v${esc(version.version)}</h2><p class="doc-status"><span class="status ${version.approved ? "approved" : "pending"}">${version.approved ? "Approved" : "Not approved yet"}</span></p><pre>${untrusted(version.content.markdown)}</pre></section>`;
    }
    const currentVersion = currentVersionOf(version.kind);
    const oneScreen = version.check?.oneScreen === undefined ? "" : `<section class="panel" id="one-screen"><h3>On one screen</h3><pre>${untrusted(version.check.oneScreen)}</pre></section>`;
    return oneScreen + await renderPlanDocument({
      anchor: ANCHOR_OF[version.kind], kind: PLAN_KIND_OF[version.kind], version: version.version, approved: version.approved, current: version.current,
      ...(currentVersion === undefined ? {} : { currentVersion }),
      plan: version.content.plan, ...(version.content.evidence === undefined ? {} : { evidence: version.content.evidence }), ...(version.check === undefined ? {} : { selfCheck: version.check.selfCheck }), local: true,
      ...(version.createdAt === undefined ? {} : { createdAt: version.createdAt }),
      openWhatChanged: false,
    });
  };
  const checks = view.checks.length === 0 ? "" : `<section class="panel"><h2>Checks</h2><ul>${view.checks.map((check) => `<li>${untrusted(check.label)}: <span class="${STATUS_CLASS[check.status]}">${STATUS_WORD[check.status]}</span></li>`).join("")}</ul></section>`;
  const findings = view.findings.length === 0 ? "" : `<section class="panel"><h2>Review findings</h2><ul>${view.findings.map((finding) => `<li><span class="tag">${esc(finding.role)}</span> ${untrusted(finding.text)}${finding.file === undefined ? "" : ` <span class="muted">${untrusted(finding.file)}${finding.line === undefined ? "" : `:${esc(finding.line)}`}</span>`}</li>`).join("")}</ul></section>`;
  const prs = view.pullRequests.length === 0 ? "" : `<section class="panel"><h2>Pull requests</h2><ul>${view.pullRequests.map((pr) => `<li>${externalLink(pr.url, `#${pr.number}`)} <span class="muted">${untrusted(pr.state)}</span>${pr.note === undefined ? "" : ` <strong class="bad">${untrusted(pr.note)}</strong>`}</li>`).join("")}</ul></section>`;
  const breakdown = view.breakdown === undefined ? "" : breakdownHtml(view.breakdown);
  const documents = (await Promise.all(current.map(one))).join("");
  const olderHtml = older.length === 0 ? "" : `<details><summary>${older.length} older ${older.length === 1 ? "version" : "versions"}</summary>${(await Promise.all(older.map(one))).join("")}</details>`;
  return layout({
    title: `Plan: ${view.title}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>${untrusted(view.title)}</h1><p class="muted">${untrusted(view.status)} · revision ${esc(view.revision)} · <a href="${esc(context.base)}/proof/${esc(view.taskId)}">Proof report</a></p>`
      + `${attentionHtml(context, view)}${critiqueHtml(view)}${secondReviewHtml(context, view)}${designNoteHtml(view)}${decideHtml(context, view)}${documents}${breakdown}${olderHtml}${checks}${findings}${prs}${commentsHtml(context, view)}`,
  });
}

// ---- design review

const SEVERITY_CLASS = { blocker: "bad", concern: "warn", note: "muted" } as const;

export function renderDesignReview(context: PageContext, view: DesignReviewView): string {
  const asset = (mockupId: string) => `${esc(context.base)}/design/${esc(view.taskId)}/mockup/${esc(mockupId)}`;
  const mockups = view.mockups.length === 0 ? "<p class=\"muted\">No mockups.</p>" : view.mockups.map((mockup) => `<figure id="mockup-${esc(mockup.id)}"><img src="${asset(mockup.id)}" alt="${untrusted(mockup.caption)}"><figcaption>${untrusted(mockup.caption)}</figcaption></figure>`).join("");
  const findings = view.findings.length === 0 ? "<p class=\"muted\">The reviewers raised nothing.</p>" : `<ul>${view.findings.map((finding) => `<li><span class="tag ${SEVERITY_CLASS[finding.severity]}">${esc(finding.severity)}</span> ${untrusted(finding.text)} <span class="muted">${untrusted(finding.reviewer)}</span>${finding.evidence.length === 0 ? "" : `<br><span class="muted">Evidence: ${finding.evidence.map((item) => (item.mockupId === undefined ? untrusted(item.label) : `<a href="#mockup-${esc(item.mockupId)}">${untrusted(item.label)}</a>`)).join(", ")}</span>`}</li>`).join("")}</ul>`;
  const offer = view.approval;
  const decide = offer === undefined ? "" : `<section class="panel" id="decide"><h2>Your decision</h2>`
    + `<p>You are deciding revision ${esc(offer.revision)} of this design. If it changes before you press a button, nothing is sent.</p>`
    + `<form class="decide" method="post" action="${esc(context.base)}/design/${esc(view.taskId)}/decide">${approvalFields(context, "design.decide", view.taskId, offer)}`
    + "<label>Why (needed if you reject)<br><textarea name=\"note\" maxlength=\"4000\"></textarea></label>"
    + "<div class=\"row\"><button class=\"primary\" type=\"submit\" name=\"decision\" value=\"approve\">Approve this design</button>"
    + "<button class=\"danger\" type=\"submit\" name=\"decision\" value=\"reject\">Reject it</button></div></form></section>";
  return layout({
    title: `Design review: ${view.title}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>${untrusted(view.title)}</h1><p class="muted">Design review · ${esc(view.state)} · revision ${esc(view.revision)}</p><p>${untrusted(view.summary)}</p>${decide}<h2>Mockups</h2>${mockups}<h2>Findings</h2>${findings}`,
  });
}

// ---- lessons

export function renderLessons(context: PageContext, lessons: readonly LessonView[]): string {
  const form = (lesson: LessonView, action: "approve" | "retire" | "wrong", label: string, cls = "") =>
    `<form method="post" action="${esc(context.base)}/lessons/act" class="row">${hidden("lessonId", lesson.id)}${hidden("action", action)}${hidden("ft", context.formToken({ action: "lesson.act", subject: `${lesson.id}:${action}:${lesson.status}` }))}<button type="submit" class="${cls}">${esc(label)}</button></form>`;
  const rows = lessons.map((lesson) => `<tr><td>${untrusted(lesson.text)}<br><span class="muted">${untrusted(lesson.scope)}</span></td><td>${esc(lesson.status)}</td>`
    + `<td>${lesson.usedIn.length === 0 ? "<span class=\"muted\">not used yet</span>" : lesson.usedIn.slice(0, 5).map((use) => `<a href="${esc(context.base)}/proof/${esc(use.taskId)}">${untrusted(use.title)}</a>`).join("<br>")}</td>`
    + `<td>${lesson.status === "proposed" ? form(lesson, "approve", "Approve", "primary") : ""}${lesson.status !== "retired" ? form(lesson, "wrong", "Wrong", "danger") + form(lesson, "retire", "Retire") : ""}</td></tr>`);
  return layout({
    title: "Lessons", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Lessons</h1>${rows.length === 0 ? "<p class=\"muted\">Rovara has not learned a lesson here yet.</p>" : `<table><thead><tr><th>Lesson</th><th>Status</th><th>Used in</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`}`,
  });
}

// ---- proof

export function renderProof(context: PageContext, view: ProofReportView): string {
  const rows = view.rows.map((row) => `<tr><td>${untrusted(row.claim)}</td><td>${untrusted(row.check)}</td><td class="${STATUS_CLASS[row.status]}">${STATUS_WORD[row.status]}</td><td>${row.detail === undefined ? "" : untrusted(row.detail)}</td></tr>`);
  const prs = view.pullRequests.length === 0 ? "" : `<p>${view.pullRequests.map((pr) => externalLink(pr.url, `Pull request #${pr.number}`) + ` <span class="muted">${untrusted(pr.state)}</span>`).join(" · ")}</p>`;
  return layout({
    title: `Proof: ${view.title}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>${untrusted(view.title)}</h1><p class="muted">Proof report · revision ${esc(view.revision)}${view.cost === undefined ? "" : ` · ${untrusted(view.cost)}`}</p><p>${untrusted(view.summary)}</p>${prs}`
      + `${rows.length === 0 ? "<p class=\"muted\">No claims to prove yet.</p>" : `<table><thead><tr><th>Claim</th><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows.join("")}</tbody></table>`}`
      + `<p><a href="${esc(context.base)}/plan/${esc(view.taskId)}">Back to the plan</a></p>`,
  });
}

// ---- script tokens

const TOKEN_STATUS_CLASS = { active: "ok", expired: "warn", revoked: "bad" } as const;
const PERMISSION_WORDS: Record<string, string> = { read: "read your tasks on these projects", start: "start tasks on these projects" };

/**
 * The script tokens page: the tokens (names, hints and states, never a secret), a form to make one when this page session is fresh enough, and a Revoke button for each live token. A token reaches only
 * what the page says: read the owner's tasks on its projects and start a task on one of them. It never approves anything.
 */
export function renderScriptTokens(context: PageContext, view: ScriptTokensPageView, options: { canMake: boolean; created?: CreatedScriptToken }): string {
  const created = options.created === undefined ? "" : `<section class="panel" id="created"><h2>Your new token</h2>`
    + "<p><strong>Copy it now.</strong> It is shown this once and is not kept anywhere: Rovara stores only a fingerprint of it. If you lose it, revoke it and make another.</p>"
    + `<p><code>${esc(options.created.secret)}</code></p>`
    + `<p class="muted">${untrusted(options.created.token.name)}: ${options.created.token.permissions.map((permission) => esc(PERMISSION_WORDS[permission] ?? permission)).join(" and ")}, until ${esc(options.created.token.expiresAt)}.</p></section>`;
  const rows = view.tokens.map((token) => `<tr><td>${untrusted(token.name)}<br><code>${esc(token.hint)}</code></td>`
    + `<td>${token.projects.map((project) => untrusted(project)).join(", ")}</td><td>${token.permissions.map(esc).join(", ")}</td>`
    + `<td><span class="${TOKEN_STATUS_CLASS[token.status]}">${esc(token.status)}</span><br><span class="muted">until ${esc(token.expiresAt)}${token.lastUsedAt === undefined ? "" : `, last used ${esc(token.lastUsedAt)}`}</span></td>`
    + `<td>${token.status === "active" ? `<form method="post" action="${esc(context.base)}/tokens/revoke" class="row">${hidden("tokenId", token.tokenId)}${hidden("ft", context.formToken({ action: "tokens.revoke", subject: token.tokenId }))}<button class="danger" type="submit">Revoke</button></form>` : ""}</td></tr>`);
  const requestId = randomUUID();
  const form = !options.canMake
    ? "<p class=\"muted\">To make a token, open this page again with <code>rovara token create</code>: a token lasts for weeks, so making one needs a page you opened in the last few minutes.</p>"
    : view.projects.length === 0 ? "<p class=\"muted\">Register a project first: a token is made for the projects it may use.</p>"
    : `<form class="decide" method="post" action="${esc(context.base)}/tokens/create">${hidden("requestId", requestId)}${hidden("ft", context.formToken({ action: "tokens.create", requestId }))}`
      + `<label>A name for it (such as the script that uses it)<br><input type="text" name="name" maxlength="${SCRIPT_TOKEN_NAME_MAX}" required autocomplete="off"></label>`
      + `<fieldset><legend>Projects it may use</legend>${view.projects.map((project) => `<label><input type="checkbox" name="project" value="${esc(project)}"> ${untrusted(project)}</label>`).join(" ")}</fieldset>`
      + `<fieldset><legend>What it may do</legend>${SCRIPT_TOKEN_PERMISSIONS.map((permission) => `<label><input type="checkbox" name="permission" value="${esc(permission)}"${permission === "read" ? " checked" : ""}> ${esc(PERMISSION_WORDS[permission] ?? permission)}</label>`).join(" ")}</fieldset>`
      + `<label>Days it lasts (1 to ${SCRIPT_TOKEN_MAX_DAYS})<br><input type="number" name="days" min="1" max="${SCRIPT_TOKEN_MAX_DAYS}" value="${SCRIPT_TOKEN_DEFAULT_DAYS}"></label>`
      + "<div class=\"row\"><button class=\"primary\" type=\"submit\">Make the token</button></div></form>";
  return layout({
    title: "Script tokens", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Script tokens</h1><p>A script token lets your own scripts on this computer read your tasks and start tasks on the projects you choose, without your session. It can do nothing else: it cannot approve a plan, merge, or make another token. You can revoke it at any time.</p>`
      + `${created}<section class="panel" id="make"><h2>Make a token</h2>${form}</section>`
      + `${rows.length === 0 ? "<p class=\"muted\">You have no script tokens.</p>" : `<table><thead><tr><th>Token</th><th>Projects</th><th>May</th><th>State</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`}`,
  });
}

// ---- second review settings

const refValue = (model: { provider: string; modelId: string }): string => `${model.provider}::${model.modelId}`;
const MODES: ReadonlyArray<{ value: string; label: string }> = [{ value: "off", label: "Off" }, { value: "shadow", label: "Shadow (shown as an opinion, never blocks)" }, { value: "on", label: "On (its blocking findings block)" }];

/** The page where the owner chooses the model that gives the second opinion and how it counts. Everything the models say about themselves is Rovara's fixed words or the catalog's names; every change is one verified form. */
export function renderSecondReview(context: PageContext, state: SecondReviewState): string {
  const form = (op: string, inner: string, label: string, cls = ""): string =>
    `<form class="decide" method="post" action="${esc(context.base)}/second-review/act">${hidden("op", op)}${hidden("ft", context.formToken({ action: "second-review.act", subject: op }))}${inner}<div class="row"><button${cls === "" ? "" : ` class="${cls}"`} type="submit">${esc(label)}</button></div></form>`;
  const eligible = state.models.filter((entry) => entry.eligible);
  const options = (selected?: string): string => eligible.map((entry) => `<option value="${esc(refValue(entry.model))}"${selected === refValue(entry.model) ? " selected" : ""}>${untrusted(entry.model.modelId)} (${untrusted(entry.model.provider)}${entry.costUsd === undefined ? "" : `, about $${entry.costUsd.toFixed(3)} a review`}${entry.suggested ? ", suggested" : ""})</option>`).join("");
  const now = state.current.source === "none" ? `<p class="warn">${state.current.reason === undefined ? "Nothing qualifies." : untrusted(`Nothing qualifies (${state.current.reason}).`)}</p>`
    : `<p>${untrusted(state.current.line ?? "")}</p>`;
  const notice = state.notice === null ? "" : `<section class="panel"><h2>Notice</h2>${state.notice.lines.map((line) => `<p>${untrusted(line)}</p>`).join("")}${state.notice.seen ? "<p class=\"muted\">You have seen this.</p>" : form("notice-seen", hidden("key", state.notice.key), "I have seen it")}</section>`;
  const pending = state.pending === undefined || state.pending.length === 0 ? "" : `<section class="panel"><h2>Waiting for a different person</h2><ul>${state.pending.map((change) => `<li>${esc(change.scope)}${change.project === undefined ? "" : ` ${untrusted(change.project)}`}: ${esc(change.from)} to ${esc(change.to)} ${form("cancel-mode", hidden("changeId", change.changeId), "Withdraw")}</li>`).join("")}</ul></section>`;
  const modeNow = `<p>Company mode: <strong>${esc(state.modes.company)}</strong>.</p>`;
  const evidence = state.evidence === null ? "<p class=\"muted\">No evidence is on record for the model that would review.</p>"
    : `<p>${untrusted(state.evidence.model.modelId)}: the evidence ${state.evidence.holds ? "<span class=\"ok\">holds</span>, so it may block" : "<span class=\"warn\">does not hold yet</span>, so it can only give an opinion"}.${state.evidence.verdict === null ? "" : ` Shadow: ${esc(state.evidence.verdict.shadowFindings)} findings over ${esc(state.evidence.verdict.shadowDays)} days, ${esc(state.evidence.verdict.shadowAgreed)} agreed with.`}</p>`
      + (state.evidence.verdict !== null && !state.evidence.verdict.withdrawn ? form("withdraw", hidden("model", refValue(state.evidence.model)), "Withdraw this evidence", "danger") : "");
  const track = state.trackRecord === null ? "" : `<p class="muted">Track record (last 90 days): ${esc(state.trackRecord.reviews)} reviews, ${esc(state.trackRecord.findings)} findings, ${esc(state.trackRecord.agreed)} agreed with, ${esc(state.trackRecord.wrong)} not.</p>`;
  const rows = state.models.map((entry) => `<tr><td>${untrusted(entry.model.modelId)}<br><span class="muted">${untrusted(entry.model.provider)} · ${untrusted(entry.company)}</span></td><td>${entry.costUsd === undefined ? "<span class=\"muted\">price unknown</span>" : `about $${entry.costUsd.toFixed(3)}`}</td>`
    + `<td>${entry.eligible ? (entry.suggested ? `<span class="ok">suggested</span>${entry.suggestionReason === undefined ? "" : `<br><span class="muted">${untrusted(entry.suggestionReason)}</span>`}` : "fits") : `<span class="muted">${entry.ineligibleWhy === "same-company" ? "same AI company as the code" : "maker not known"}</span>`}${entry.notes.map((note) => `<br><span class="warn">${untrusted(note)}</span>`).join("")}${entry.trackRecord === undefined ? "" : `<br><span class="muted">${untrusted(entry.trackRecord)}</span>`}</td></tr>`);
  const choose = eligible.length === 0 ? "<p class=\"muted\">No model can be chosen: connect a model key from a different AI company than the one that writes the code.</p>"
    : form("choose", `<label>Reviewer<br><select name="primary">${options(state.choice?.models[0] === undefined ? undefined : refValue(state.choice.models[0]))}</select></label>`
      + `<label>Backup (optional)<br><select name="backup"><option value="">None</option>${options(state.choice?.models[1] === undefined ? undefined : refValue(state.choice.models[1]))}</select></label>`, "Choose this reviewer", "primary")
      + (state.choice === null ? "" : form("clear", "", "Go back to the default"));
  return layout({
    title: "Second review", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Second review</h1><p class="muted">A second opinion on each task's code from a model of a different AI company than the one that wrote it. It never replaces the first review.</p>${notice}${pending}`
      + `<section class="panel"><h2>Who reviews now</h2>${now}${choose}</section>`
      + `<section class="panel"><h2>How it counts</h2>${modeNow}${form("mode", `${hidden("scope", "company")}<label>Mode<br><select name="mode">${MODES.map((mode) => `<option value="${esc(mode.value)}"${state.modes.company === mode.value ? " selected" : ""}>${esc(mode.label)}</option>`).join("")}</select></label>`, "Set the company mode", "primary")}`
      + `${evidence}${track}</section>`
      + `<section class="panel"><h2>What it sees</h2><p>${state.context === "same_as_first" ? "The change and what the first reviewer sees: the connected sources, lessons and step instructions." : "Only the change."}</p>`
      + `${form("context", `<label>Context<br><select name="context"><option value="change_only"${state.context === "change_only" ? " selected" : ""}>Only the change</option><option value="same_as_first"${state.context === "same_as_first" ? " selected" : ""}>Same as the first reviewer</option></select></label>`, "Set what it sees")}</section>`
      + `<section class="panel"><h2>One project</h2>${form("mode", `${hidden("scope", "project")}<label>Project name<br><input type="text" name="project" maxlength="64" required autocomplete="off"></label><label>Mode<br><select name="mode"><option value="inherit">Same as the company</option>${MODES.map((mode) => `<option value="${esc(mode.value)}">${esc(mode.label)}</option>`).join("")}</select></label>`, "Set the project's mode")}</section>`
      + `<section class="panel" id="evidence"><h2>Evidence</h2><p class="muted">What lets a model block: a replay run from the quality suite and a shadow window counted from your own tasks. Recording or withdrawing it needs a page opened within the last ten minutes (run <code>rovara second-review evidence</code> to get one).</p>`
      + `${form("replay", "<label>Replay run (JSON)<br><textarea name=\"run\" maxlength=\"30000\" required></textarea></label>", "Store the replay run")}`
      + `${eligible.length === 0 ? "" : form("verdict", `<label>Model<br><select name="model">${options()}</select></label><label>Replay run id<br><input type="text" name="run" maxlength="64" required autocomplete="off"></label><label>Shadow window from (ISO time)<br><input type="text" name="from" maxlength="40" required autocomplete="off"></label><label>to<br><input type="text" name="to" maxlength="40" required autocomplete="off"></label>`, "Record the evidence")}</section>`
      + `<section class="panel"><h2>Models</h2>${rows.length === 0 ? "<p class=\"muted\">No model is available.</p>" : `<table><thead><tr><th>Model</th><th>Cost of one review</th><th>Fit</th></tr></thead><tbody>${rows.join("")}</tbody></table>`}</section>`,
  });
}
