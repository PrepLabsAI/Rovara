// Lane L8: the five pages, as pure functions from a view model to HTML. A page that takes a decision draws its form with a form token that binds the
// exact content shown; the server checks that binding again when the form comes back.
import { randomUUID } from "node:crypto";
import { DIAGNOSIS_ANSWER_LABEL, SCRIPT_TOKEN_DEFAULT_DAYS, SCRIPT_TOKEN_MAX_DAYS, SCRIPT_TOKEN_NAME_MAX, SCRIPT_TOKEN_PERMISSIONS, type CreatedScriptToken, type PlanDocumentKind } from "@agentx/contracts";
import { renderPlanDocument, type PlanAnchor } from "../../aws/plan-page/render-plan.js";
import { esc, externalLink, layout, untrusted } from "./html.js";
import type { FormBinding } from "./guard.js";
import { PART_STATE_WORDS } from "../work-breakdown/view.js";
import type {
  ApprovalOffer, AutomationPageView, ChatPageView, CommentView, DesignReviewView, LessonReposView, LessonView, PendingItemView, PlanPageView, PlanVersionView, ProofReportView, ScriptTokensPageView, TestEnvironmentPageView,
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

/** What the task is expected to cost, what it has cost so far and the model each step used. Rovara's words around data (a model's name is drawn as untrusted text). */
function costAndModelsHtml(view: PlanPageView): string {
  if (view.costAndModels === undefined || view.costAndModels.length === 0) return "";
  return `<section class="panel" id="cost"><h2>Cost and models</h2>${view.costAndModels.map((line) => `<p>${untrusted(line)}</p>`).join("")}</section>`;
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

/** The line that says a design's review did not run (fixed words), in front of the approval form. The review's own panel carries it when there is one. */
function designNoteHtml(view: PlanPageView): string {
  return view.designNote === undefined || view.designReview !== undefined ? "" : `<p class="panel" id="design-not-run"><strong>${esc(view.designNote)}</strong></p>`;
}

const SEVERITY_TAG = { blocker: "bad", major: "warn", nit: "muted" } as const;

/** The design review's panel: how it went, what is open, and the forms for what waits for the owner. Findings are model words and are shown as untrusted text. */
function designReviewHtml(context: PageContext, view: PlanPageView): string {
  const review = view.designReview;
  if (review === undefined) return "";
  const findings = review.findings.length === 0 ? "<p class=\"muted\">The reviewers raised nothing.</p>"
    : `<ul>${review.findings.map((finding) => `<li><span class="tag ${SEVERITY_TAG[finding.severity]}">${esc(finding.severity)}</span> <span class="muted">${untrusted(finding.section)} · ${untrusted(finding.from)}</span> ${untrusted(finding.text)}${finding.resolution === undefined ? "" : ` <span class="muted">(${untrusted(finding.resolution)})</span>`}${finding.open ? "" : " <span class=\"muted\">settled</span>"}</li>`).join("")}</ul>`;
  const hold = review.hold === undefined ? "" : `<section class="panel" id="design-hold"><h2>${untrusted(review.hold.why)}</h2><p>Nothing runs until you choose.</p>${review.hold.note === undefined ? "" : `<p class="muted">${esc(review.hold.note)}</p>`}<div class="row">${review.hold.choices.map((choice) =>
    `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/design-choice">${approvalFields(context, "design.choice", view.taskId, review.hold!.offer)}${hidden("choice", choice.choice)}<button type="submit"${choice.choice === "run_unpriced" ? " class=\"primary\"" : ""}>${untrusted(choice.label)}</button></form>`).join("")}</div></section>`;
  const parked = review.parked === undefined ? "" : `<section class="panel" id="design-parked"><h2>Paused</h2><p>This waited a week, so nothing is running or spending. Pick it up again when you are ready.</p>`
    + `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/design-resume">${hidden("revision", review.parked.revision)}${hidden("ft", context.formToken({ action: "design.resume", taskId: view.taskId, revision: review.parked.revision }))}<div class="row"><button class="primary" type="submit">Pick it up again</button></div></form></section>`;
  const reason = review.blockerReasonNeeded === true ? "<p class=\"bad\">A blocker is still open. To approve this design, say in one line why in the box below (the box that asks what to change).</p>" : "";
  return `<section class="panel" id="design-review"><h2>Design review</h2><p>${untrusted(review.status)}</p>${review.facts.length === 0 ? "" : `<ul>${review.facts.map((fact) => `<li>${untrusted(fact)}</li>`).join("")}</ul>`}${reason}<h3>Findings</h3>${findings}</section>${hold}${parked}`;
}

/**
 * Fix with agent: the button (a form to this page's own `diagnose` route, bound to the error as shown and to this press), why it is not offered, and the diagnosis in plain lines. The lines are a model's words: untrusted
 * text, never a link or a control. Nothing here changes anything; a suggestion is done with the page's ordinary forms (Retry, the plan's decision).
 */
function diagnosisHtml(context: PageContext, view: PlanPageView): string {
  const fix = view.diagnosis;
  if (fix === undefined) return "";
  const parts: string[] = [];
  if (fix.state === "waiting") parts.push("<p role=\"status\">Fix with agent is looking into this error. Reload this page in a moment.</p>");
  if (fix.state === "failed") parts.push(`<p class="bad" role="alert">${untrusted(fix.failure ?? "Couldn't diagnose this now.")}</p>`);
  if (fix.state === "ready") {
    parts.push(fix.lines === undefined || fix.lines.length === 0 ? "<p>No suggestion came back for this error.</p>" : `<ul>${fix.lines.map((line) => `<li>${untrusted(line)}</li>`).join("")}</ul>`);
    if (fix.needsCode === true) parts.push("<p class=\"muted\">The answer says the cause is in the code. A deeper look at the repositories is not on this install yet.</p>");
    parts.push(`<p class="muted">${esc(DIAGNOSIS_ANSWER_LABEL)}</p>`);
  }
  if (fix.offer !== undefined) {
    const again = fix.state === "failed" ? "Try again" : "Fix with agent";
    parts.push(fix.state === "waiting" || fix.state === "ready" ? "" : `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/diagnose">${hidden("requestId", fix.offer.requestId)}${hidden("errorKey", fix.offer.errorKey)}`
      + `${hidden("ft", context.formToken({ action: "task.diagnose", taskId: view.taskId, requestId: fix.offer.requestId, subject: fix.offer.errorKey }))}`
      + `<p class="muted">An AI model reads this error's data and suggests what to do. It runs on your own model key, can be wrong, and changes nothing.</p><div class="row"><button class="primary" type="submit">${esc(again)}</button></div></form>`);
  } else if (fix.why !== undefined && fix.state === undefined) parts.push(`<p class="muted">${untrusted(fix.why)}</p>`);
  return `<section class="panel" id="fix-with-agent"><h2>Fix with agent</h2>${parts.join("")}</section>`;
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
      + `${attentionHtml(context, view)}${diagnosisHtml(context, view)}${critiqueHtml(view)}${costAndModelsHtml(view)}${secondReviewHtml(context, view)}${designNoteHtml(view)}${designReviewHtml(context, view)}${decideHtml(context, view)}${documents}${breakdown}${olderHtml}${checks}${findings}${prs}${commentsHtml(context, view)}`,
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

export function renderLessons(context: PageContext, lessons: readonly LessonView[], repos: readonly LessonReposView[] = []): string {
  const form = (lesson: LessonView, action: "approve" | "retire" | "wrong", label: string, cls = "") =>
    `<form method="post" action="${esc(context.base)}/lessons/act" class="row">${hidden("lessonId", lesson.id)}${hidden("action", action)}${hidden("ft", context.formToken({ action: "lesson.act", subject: `${lesson.id}:${action}:${lesson.status}`, ...(action === "approve" && lesson.offer !== undefined ? { requestId: lesson.offer.requestId, revision: lesson.offer.revision, artifactDigest: lesson.offer.artifactDigest } : {}) }))}<button type="submit" class="${cls}">${esc(label)}</button></form>`;
  const repoForm = (project: string, repo: string, action: "on" | "off" | "resume" | "pointer_add" | "pointer_decline", label: string, cls = "") =>
    `<form method="post" action="${esc(context.base)}/lessons/repo" class="row">${hidden("project", project)}${hidden("repo", repo)}${hidden("action", action)}${hidden("ft", context.formToken({ action: "lesson.repo", subject: `${project}:${repo}:${action}` }))}<button type="submit" class="${cls}">${esc(label)}</button></form>`;
  const repoBlocks = repos.filter((view) => view.repos.length > 0 || view.available.length > 0).map((view) => {
    const lines = view.repos.map((row) => `<tr><td>${untrusted(row.repo)}</td><td>${row.enabled ? "on" : "off"}</td><td>${row.notices.map((line) => untrusted(line)).join("<br>")}</td>`
      + `<td>${row.enabled ? repoForm(view.project, row.repo, "off", "Switch off") : repoForm(view.project, row.repo, "on", "Switch on", "primary")}${row.fileDeleted ? repoForm(view.project, row.repo, "resume", "Resume") : ""}${row.pointer === "missing" ? repoForm(view.project, row.repo, "pointer_add", "Add the pointer") + repoForm(view.project, row.repo, "pointer_decline", "Do not ask again") : ""}</td></tr>`);
    const more = view.canEnable ? view.available.map((name) => `<tr><td>${untrusted(name)}</td><td>off</td><td></td><td>${repoForm(view.project, name, "on", "Switch on", "primary")}</td></tr>`) : [];
    return `<h3>${untrusted(view.project)}</h3><table><thead><tr><th>Repository</th><th>Lessons file</th><th></th><th></th></tr></thead><tbody>${[...lines, ...more].join("")}</tbody></table>`;
  });
  const repoSection = repoBlocks.length === 0 ? "" : `<h2>Lessons in the repository</h2><p class="muted">Rovara can keep a <code>.rovara/lessons.md</code> file in a repository and open one pull request a week to update it. Switching it on needs a page opened in the last few minutes: run <code>rovara open lessons</code> to open one.</p>${repoBlocks.join("")}`;
  const rows = lessons.map((lesson) => `<tr><td>${untrusted(lesson.text)}<br><span class="muted">${untrusted(lesson.scope)}</span>${lesson.retireRequest === undefined ? "" : `<br><strong>${untrusted(lesson.retireRequest.by)} asked, in a comment on pull request ${String(lesson.retireRequest.pullRequest)}, for this lesson to be retired. Press Retire to confirm.</strong>`}</td><td>${esc(lesson.status)}</td>`
    + `<td>${lesson.usedIn.length === 0 ? "<span class=\"muted\">not used yet</span>" : lesson.usedIn.slice(0, 5).map((use) => `<a href="${esc(context.base)}/proof/${esc(use.taskId)}">${untrusted(use.title)}</a>`).join("<br>")}</td>`
    + `<td>${lesson.status === "proposed" ? form(lesson, "approve", "Approve", "primary") : ""}${lesson.status !== "retired" ? form(lesson, "wrong", "Wrong", "danger") + form(lesson, "retire", "Retire") : ""}</td></tr>`);
  return layout({
    title: "Lessons", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Lessons</h1>${rows.length === 0 ? "<p class=\"muted\">Rovara has not learned a lesson here yet.</p>" : `<table><thead><tr><th>Lesson</th><th>Status</th><th>Used in</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`}${repoSection}`,
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

// ---- Test environments

const RISK_WORDS = { low: "low", medium: "medium", high: "high: only a strong proof (this page) can approve it" } as const;

/** One project's test environment: what is approved, and the proposal that waits (what changes, how risky, whether a Prove run passed) with an Approve button only when the proposal was proved. */
export function renderTestEnvironment(context: PageContext, view: TestEnvironmentPageView): string {
  const approved = view.approved === undefined
    ? "<p class=\"muted\">No test environment is approved for this project: its tasks run the project's own checks.</p>"
    : `<p>Revision ${esc(view.approved.revision)}, approved ${esc(view.approved.approvedAt)}${view.approved.approvedBy === undefined ? "" : ` by ${untrusted(view.approved.approvedBy)}`}.</p><ul>${view.approved.lines.map((line) => `<li>${untrusted(line)}</li>`).join("")}</ul>`
      + (view.approved.checks.length === 0 ? "" : `<h3>Checks</h3><ul>${view.approved.checks.map((check) => `<li>${untrusted(check.label)} <span class="muted">(${esc(check.kind)})</span></li>`).join("")}</ul>`);
  let proposal = "<p class=\"muted\">Nothing is waiting for approval.</p>";
  if (view.proposal !== undefined) {
    const offer = view.approval;
    const form = offer === undefined
      ? `<p class="muted">${view.proposal.proved ? "This proposal is no longer the one that can be approved." : "It cannot be approved until a Prove run (boot, smoke test and a full run) passes for exactly this proposal."}</p>`
      : `<form class="decide" method="post" action="${esc(context.base)}/test-environment/${esc(encodeURIComponent(view.project))}/decide">${approvalFields(context, "testenv.decide", view.project, offer)}<div class="row"><button class="primary" type="submit">Approve revision ${esc(offer.revision)}</button></div></form>`;
    proposal = `<p>Proposed ${esc(view.proposal.proposedAt)}. Risk: <strong class="${view.proposal.risk === "high" ? "bad" : view.proposal.risk === "medium" ? "warn" : "ok"}">${esc(RISK_WORDS[view.proposal.risk])}</strong>. `
      + `Prove run: <span class="${view.proposal.proved ? "ok" : "warn"}">${view.proposal.proved ? "passed" : "not passed"}</span>.${view.proposal.expiresAt === undefined ? "" : ` Approve it before ${esc(view.proposal.expiresAt)}.`}</p>`
      + (view.proposal.lessSafe.length === 0 ? "" : `<p class="warn">Less safe than the approved revision: ${view.proposal.lessSafe.map((word) => esc(word.replace(/_/gu, " "))).join(", ")}.</p>`)
      + `<h3>What changes</h3>${view.proposal.changes.length === 0 ? "<p class=\"muted\">Nothing differs from the approved revision.</p>" : `<ul>${view.proposal.changes.map((line) => `<li><code>${untrusted(line)}</code></li>`).join("")}</ul>`}${form}`;
  }
  const extra = view.extra === undefined || view.extra.length === 0 ? "" : `<section class="panel"><h2>More</h2><ul>${view.extra.map((line) => `<li>${untrusted(line)}</li>`).join("")}</ul></section>`;
  return layout({
    title: `Test environment: ${view.project}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Test environment: ${untrusted(view.project)}</h1><p>The environment tasks of this project run their checks in, and the nightly run uses. A change is approved here, by you, once it has been proved.</p>`
      + `<section class="panel"><h2>Approved</h2>${approved}</section><section class="panel"><h2>Waiting for approval</h2>${proposal}</section>${extra}`,
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

// ---- Automation

/**
 * The automation page: the triggers (what starts work with no one watching) and the chain runs waiting at a gate. Turning a trigger on and deciding a gate are the owner's acts here and nowhere else: each form carries a
 * proof signed over exactly what it shows, so a trigger or a gate that changed since the page was drawn is refused.
 */
export function renderAutomation(context: PageContext, view: AutomationPageView): string {
  const form = (op: string, fields: string, label: string, subject: string, cls = ""): string =>
    `<form class="decide" method="post" action="${esc(context.base)}/automation/act">${hidden("op", op)}${fields}${hidden("ft", context.formToken({ action: "automation.act", subject: `${op}:${subject}` }))}<div class="row"><button${cls === "" ? "" : ` class="${cls}"`} type="submit">${esc(label)}</button></div></form>`;
  const offerFields = (offer: ApprovalOffer): string => hidden("requestId", offer.requestId) + hidden("revision", offer.revision) + hidden("digest", offer.artifactDigest);
  const triggers = view.triggers.length === 0 ? "<p class=\"muted\">No trigger is set up.</p>" : `<table><thead><tr><th>Starts</th><th>When</th><th>State</th><th></th></tr></thead><tbody>${view.triggers.map((trigger) => {
    const state = trigger.enabled ? "<span class=\"ok\">on</span>" : `<span class="muted">off</span>${trigger.disabledReason === undefined ? "" : `<br><span class="warn">${untrusted(trigger.disabledReason)}</span>`}`;
    const problems = trigger.problems.map((problem) => `<br><span class="warn">${untrusted(problem)}</span>`).join("");
    const act = trigger.enabled ? form("trigger-off", hidden("triggerId", trigger.triggerId), "Turn off", trigger.triggerId, "danger")
      : trigger.offer === undefined ? "" : form("trigger-on", hidden("triggerId", trigger.triggerId) + offerFields(trigger.offer), "Turn on", trigger.triggerId, "primary");
    return `<tr><td>${untrusted(trigger.target)}<br><span class="muted">on ${untrusted(trigger.project)}</span></td><td>${untrusted(trigger.what)}${trigger.lastFiredAt === undefined ? "" : `<br><span class="muted">last started ${esc(trigger.lastFiredAt)}</span>`}</td><td>${state}${problems}</td><td>${act}</td></tr>`;
  }).join("")}</tbody></table>`;
  const waiting = view.waiting.length === 0 ? "<p class=\"muted\">No chain run is waiting for you.</p>" : `<ul>${view.waiting.map((gate) => `<li><strong>${untrusted(gate.chain)}</strong>: ${untrusted(gate.step)}<br>${untrusted(gate.prompt)} <span class="muted">since ${esc(gate.since)}</span>`
    + form("gate", hidden("runId", gate.runId) + hidden("seq", gate.seq) + hidden("decision", "approved") + offerFields(gate.offers.approved), "Go on", `${gate.runId}#${String(gate.seq)}#approved`, "primary")
    + form("gate", hidden("runId", gate.runId) + hidden("seq", gate.seq) + hidden("decision", "declined") + offerFields(gate.offers.declined), "Stop here", `${gate.runId}#${String(gate.seq)}#declined`)
    + form("run-cancel", hidden("runId", gate.runId), "Cancel the run", gate.runId, "danger") + "</li>").join("")}</ul>`;
  return layout({
    title: "Automation", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Automation</h1><p class="muted">Work that starts with no one at the keyboard: an event or a schedule starts it, within the limits you set. It never approves anything: a plan, a design or a merge it reaches waits for you. A trigger is turned on here, by you, and only for what it is now.</p>`
      + `<section class="panel"><h2>Triggers</h2>${triggers}</section><section class="panel"><h2>Waiting for you</h2>${waiting}</section>`,
  });
}

// ---- Chat

/**
 * The chat page: the chat adapters this install runs, the accounts linked to you, the spaces bound to a project and where you are told. Everything on it is yours to change on this page only: a linked account can start work as
 * you, a bound space starts work on a project, and a notice target receives the titles of your tasks. Nothing here approves anything: a plan is decided on its own page.
 */
export function renderChat(context: PageContext, view: ChatPageView, options: { preview?: { code: string; channel: string; tenant: string; userId: string } }): string {
  const form = (action: string, subject: string, fields: string, button: string, danger = false): string =>
    `<form class="row" method="post" action="${esc(context.base)}/chat/${esc(action)}">${fields}${hidden("ft", context.formToken({ action: `chat.${action}`, subject }))}<button type="submit"${danger ? " class=\"danger\"" : ""}>${esc(button)}</button></form>`;
  const adapters = view.adapters.length === 0
    ? "<p class=\"muted\">No chat is set up on this install. Name a chat plug-in in your plug-in config to add one.</p>"
    : `<ul>${view.adapters.map((adapter) => `<li><strong>${untrusted(adapter.name)}</strong> <span class="muted">serves ${adapter.projects.map((project) => untrusted(project)).join(", ")}${adapter.proactive ? "" : "; cannot message first"}</span></li>`).join("")}</ul>`;
  const preview = options.preview === undefined ? ""
    : `<section class="panel" id="confirm"><h2>Link this account?</h2><p>The code names a <strong>${untrusted(options.preview.channel)}</strong> account: workspace <code>${untrusted(options.preview.tenant)}</code>, account <code>${untrusted(options.preview.userId)}</code>. Link it only if that is your own account and you just asked Rovara in the chat. Someone else's code is how a stranger gets to start work as you.</p>`
      + `${form("link", options.preview.code, `${hidden("code", options.preview.code)}${hidden("confirmed", "yes")}`, "Yes, link it as me")}</section>`;
  const linkForm = `<section class="panel" id="link"><h2>Link a chat account to you</h2><p>Message Rovara in a chat space that is bound to a project. If it does not know you yet it answers with a code. Paste the code here: the account is then yours, and its messages can start work as you.</p>`
    + `<form class="decide" method="get" action="${esc(context.base)}/chat"><label>The code<br><input type="text" name="code" maxlength="64" autocomplete="off" required></label><div class="row"><button type="submit">Look at the code</button></div></form></section>`;
  const links = view.links.length === 0 ? "<p class=\"muted\">No chat account is linked to you.</p>"
    : `<table><thead><tr><th>Chat</th><th>Account</th><th>Linked</th><th></th></tr></thead><tbody>${view.links.map((link) => `<tr><td>${untrusted(link.channel)}</td><td><code>${untrusted(link.maskedUserId)}</code></td><td class="muted">${esc(link.linkedAt)}</td><td>${form("unlink", `${link.channel}/${link.tenant}/${link.userId}`, `${hidden("channel", link.channel)}${hidden("tenant", link.tenant)}${hidden("userId", link.userId)}`, "Remove", true)}</td></tr>`).join("")}</tbody></table>`;
  const bindings = view.bindings.length === 0 ? "<p class=\"muted\">No space is bound to a project.</p>"
    : `<table><thead><tr><th>Chat</th><th>Space</th><th>Project</th><th></th></tr></thead><tbody>${view.bindings.map((binding) => `<tr><td>${untrusted(binding.channel)}</td><td><code>${untrusted(binding.space)}</code></td><td>${untrusted(binding.project)}</td><td>${form("unbind", `${binding.channel}/${binding.tenant}/${binding.space}`, `${hidden("channel", binding.channel)}${hidden("tenant", binding.tenant)}${hidden("space", binding.space)}`, "Unbind", true)}</td></tr>`).join("")}</tbody></table>`;
  const bindForm = view.adapters.length === 0 || view.projects.length === 0 ? "" : `<form class="decide" method="post" action="${esc(context.base)}/chat/bind">`
    + `<label>Chat<br><select name="channel">${view.adapters.map((adapter) => `<option value="${esc(adapter.name)}">${untrusted(adapter.name)}</option>`).join("")}</select></label>`
    + "<label>Workspace or team id<br><input type=\"text\" name=\"tenant\" maxlength=\"128\" required autocomplete=\"off\"></label><label>Space id (a channel)<br><input type=\"text\" name=\"space\" maxlength=\"128\" required autocomplete=\"off\"></label>"
    + `<label>Project<br><select name="project">${view.projects.map((project) => `<option value="${esc(project)}">${untrusted(project)}</option>`).join("")}</select></label>`
    + `${hidden("ft", context.formToken({ action: "chat.bind", subject: "new" }))}<div class="row"><button class="primary" type="submit">Bind the space</button></div></form>`;
  const targets = view.notify.targets.length === 0 ? "<p class=\"muted\">You are not told anywhere. Rovara will not message you.</p>"
    : `<table><thead><tr><th>Chat</th><th>Space</th><th>Thread</th><th></th></tr></thead><tbody>${view.notify.targets.map((target) => `<tr><td>${untrusted(target.channel)}</td><td><code>${untrusted(target.space)}</code></td><td><code>${untrusted(target.thread)}</code></td><td>${form("notice-remove", `${target.channel}/${target.tenant}/${target.space}/${target.thread}`, `${hidden("channel", target.channel)}${hidden("tenant", target.tenant)}${hidden("space", target.space)}${hidden("thread", target.thread)}`, "Remove", true)}</td></tr>`).join("")}</tbody></table>`;
  const noticeForm = view.adapters.length === 0 ? "" : `<form class="decide" method="post" action="${esc(context.base)}/chat/notice-add">`
    + `<label>Chat<br><select name="channel">${view.adapters.map((adapter) => `<option value="${esc(adapter.name)}">${untrusted(adapter.name)}</option>`).join("")}</select></label>`
    + "<label>Workspace or team id<br><input type=\"text\" name=\"tenant\" maxlength=\"128\" required autocomplete=\"off\"></label><label>Space id (a channel or a direct message)<br><input type=\"text\" name=\"space\" maxlength=\"128\" required autocomplete=\"off\"></label>"
    + "<label>Thread (leave empty for the top of the space)<br><input type=\"text\" name=\"thread\" maxlength=\"128\" autocomplete=\"off\"></label>"
    + `${hidden("ft", context.formToken({ action: "chat.notice-add", subject: "new" }))}<div class="row"><button class="primary" type="submit">Tell me here</button></div></form>`;
  const mute = form("mute", view.notify.muted ? "off" : "on", hidden("muted", view.notify.muted ? "no" : "yes"), view.notify.muted ? "Turn notices back on" : "Mute notices");
  return layout({
    title: "Chat", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: "<h1>Chat</h1><p>A chat is where Rovara can tell you what needs you, and where you can start work. Nothing said in a chat approves anything: a plan is decided on its own page, where you sign in.</p>"
      + `<section class="panel"><h2>Chats on this install</h2>${adapters}</section>${preview}${linkForm}`
      + `<section class="panel"><h2>Accounts linked to you</h2>${links}</section>`
      + `<section class="panel"><h2>Spaces bound to a project</h2>${bindings}${bindForm}</section>`
      + `<section class="panel"><h2>Where you are told</h2><p>One message at most every few minutes: what needs you, in one list. ${view.notify.muted ? "<strong>Notices are muted.</strong>" : ""}</p>${targets}${noticeForm}<div class="row">${mute}</div></section>`,
  });
}
