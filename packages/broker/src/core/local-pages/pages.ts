// Lane L8: the five pages, as pure functions from a view model to HTML. A page that takes a decision draws its form with a form token that binds the
// exact content shown; the server checks that binding again when the form comes back.
import type { PlanDocumentKind } from "@agentx/contracts";
import { renderPlanDocument, type PlanAnchor } from "../../aws/plan-page/render-plan.js";
import { esc, externalLink, layout, untrusted } from "./html.js";
import type { FormBinding } from "./guard.js";
import type {
  ApprovalOffer, CommentView, DesignReviewView, LessonView, PendingItemView, PlanPageView, PlanVersionView, ProofReportView,
} from "./views.js";

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

function decideHtml(context: PageContext, view: PlanPageView): string {
  const offer = view.approval;
  if (offer === undefined) return "";
  return `<section class="panel" id="decide"><h2>Your decision</h2>`
    + `<p>You are deciding revision ${esc(offer.revision)} of this plan. If it changes before you press a button, nothing is sent and you are asked to look again.</p>`
    + `<form class="decide" method="post" action="${esc(context.base)}/plan/${esc(view.taskId)}/decide">${approvalFields(context, "plan.decide", view.taskId, offer)}`
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

export async function renderPlanPage(context: PageContext, view: PlanPageView): Promise<string> {
  const current = view.versions.filter((version) => version.current);
  const older = view.versions.filter((version) => !version.current);
  const currentVersionOf = (kind: PlanVersionView["kind"]) => view.versions.find((version) => version.kind === kind && version.current)?.version;
  const one = async (version: PlanVersionView): Promise<string> => {
    if (version.content.format === "markdown") {
      return `<section class="doc"><h2>${esc(version.kind)} v${esc(version.version)}</h2><p class="doc-status"><span class="status ${version.approved ? "approved" : "pending"}">${version.approved ? "Approved" : "Not approved yet"}</span></p><pre>${untrusted(version.content.markdown)}</pre></section>`;
    }
    const currentVersion = currentVersionOf(version.kind);
    return renderPlanDocument({
      anchor: ANCHOR_OF[version.kind], kind: PLAN_KIND_OF[version.kind], version: version.version, approved: version.approved, current: version.current,
      ...(currentVersion === undefined ? {} : { currentVersion }),
      plan: version.content.plan, ...(version.content.evidence === undefined ? {} : { evidence: version.content.evidence }),
      ...(version.createdAt === undefined ? {} : { createdAt: version.createdAt }),
      openWhatChanged: false,
    });
  };
  const checks = view.checks.length === 0 ? "" : `<section class="panel"><h2>Checks</h2><ul>${view.checks.map((check) => `<li>${untrusted(check.label)}: <span class="${STATUS_CLASS[check.status]}">${STATUS_WORD[check.status]}</span></li>`).join("")}</ul></section>`;
  const findings = view.findings.length === 0 ? "" : `<section class="panel"><h2>Review findings</h2><ul>${view.findings.map((finding) => `<li><span class="tag">${esc(finding.role)}</span> ${untrusted(finding.text)}${finding.file === undefined ? "" : ` <span class="muted">${untrusted(finding.file)}${finding.line === undefined ? "" : `:${esc(finding.line)}`}</span>`}</li>`).join("")}</ul></section>`;
  const prs = view.pullRequests.length === 0 ? "" : `<section class="panel"><h2>Pull requests</h2><ul>${view.pullRequests.map((pr) => `<li>${externalLink(pr.url, `#${pr.number}`)} <span class="muted">${untrusted(pr.state)}</span>${pr.note === undefined ? "" : ` <strong class="bad">${untrusted(pr.note)}</strong>`}</li>`).join("")}</ul></section>`;
  const documents = (await Promise.all(current.map(one))).join("");
  const olderHtml = older.length === 0 ? "" : `<details><summary>${older.length} older ${older.length === 1 ? "version" : "versions"}</summary>${(await Promise.all(older.map(one))).join("")}</details>`;
  return layout({
    title: `Plan: ${view.title}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>${untrusted(view.title)}</h1><p class="muted">${untrusted(view.status)} · revision ${esc(view.revision)} · <a href="${esc(context.base)}/proof/${esc(view.taskId)}">Proof report</a></p>`
      + `${attentionHtml(context, view)}${decideHtml(context, view)}${documents}${olderHtml}${checks}${findings}${prs}${commentsHtml(context, view)}`,
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
