// One structured plan document as an HTML fragment for the read-only task page: a ranked claim tree folded to its
// first level, with evidence, decisions, badges and what changed. A pure function of its input apart from the
// drawing of diagrams. All model text is redacted and escaped here; the markup carries class names only (the page
// owns the styles) and no inline style or event handler.
import { commentRefInAuthor, diffPlanDocuments, plainCommentAuthor, redactText, type PlanClaim, type PlanDecision, type PlanDocument, type PlanDocumentKind, type PlanEvidenceBundle, type PlanEvidenceInput } from "@agentx/contracts";
import { escapeHtml } from "../web-session.js";
import { renderDiagram } from "./diagrams.js";
import { commentCountBadge, renderThreads, suggestionLines, targetKey, type PageCommentView, type PageSuggestionView } from "./comments.js";

export type PlanAnchor = "requirements" | "design" | "coding-plan";

export interface RenderPlanInput {
  anchor: PlanAnchor;
  kind: PlanDocumentKind; version: number; approved: boolean; current: boolean;
  /** The current version's number, so an older version can say which one is current. */
  currentVersion?: number;
  plan: PlanDocument; evidence?: PlanEvidenceBundle;
  /** When the document was stored and the time now (epoch milliseconds): the current version's code is still being loaded for a short while after it was stored. */
  createdAt?: string; now?: number;
  previous?: { version: number; plan: PlanDocument };
  approvedEarlier?: PlanDocument;
  checks?: Array<{ id?: string; label: string; proposed: boolean; proves: string[]; status: string }>;
  /** Checks the task knows that the table does not list (an optional check not chosen): their threads stay with the checks. */
  knownChecks?: Array<{ id: string; label: string }>;
  openWhatChanged: boolean;
  /** Spec 061 slice 2, the current version only: the task's comments (any document; this one's up to this version show). */
  comments?: PageCommentView[];
  /** The suggestions that apply to this version. */
  suggestions?: PageSuggestionView[];
  /** What the reader may do on the page. */
  access?: { canComment: boolean; canSuggest: boolean; canDecide: boolean };
  /** The owner answers this version's decisions here: it is current and waits for their decision. */
  deciding?: boolean;
  /** Every structured version of this document by number, to quote a removed claim's words. */
  plans?: ReadonlyMap<number, PlanDocument>;
  /** The comments a quote's author names by ref ("comment c1"): who wrote each, and whether it is the reader's, so the quote reads "Your comment". */
  commentRefs?: Record<string, { id: string; name: string; you: boolean }>;
}

/** How many claims, per level, and how many decisions in all, show before the rest fold away. */
const SHOWN = 5;
const WHY_SUMMARY_MAX_CHARS = 120;
const CLAIM_ID = /^[1-9][0-9]{0,2}(\.[1-9][0-9]{0,2}){0,2}$/;

/** The element ID of a claim: `design-v2-1-2` for claim `1.2` of design v2. The page's script builds the same IDs. */
export function claimAnchor(anchor: PlanAnchor, version: number, claimId: string): string {
  return `${anchor}-v${version}-${claimId.replace(/\./g, "-")}`;
}

/** Model text made safe for HTML: secrets removed, then escaped. */
const t = (value: string): string => escapeHtml(redactText(value));
const cut = (value: string, max: number): string => {
  const characters = Array.from(value.replace(/\s+/g, " ").trim());
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("")}…`;
};
const DECISION_QUESTION_MAX_CHARS = 80;
/** How long after a plan was stored its cited code is still said to be loading. */
export const EVIDENCE_LOADING_MS = 15 * 60_000;
const KIND_LABEL: Record<PlanDocumentKind, string> = { requirements: "Requirements", design: "Design", plan: "Coding plan" };

function flatten(claims: PlanClaim[]): PlanClaim[] {
  return claims.flatMap((claim) => [claim, ...flatten(claim.children ?? [])]);
}

interface Context {
  input: RenderPlanInput;
  excerpts: Map<string, PlanEvidenceBundle["excerpts"][number]>;
  newIds: Set<string>;
  changedIds: Set<string>;
  changedAfterApprovalIds: Set<string>;
  decisionsInClaims: Map<string, PlanDecision[]>;
  /** The threads shown on this version, by place ("claim:2.1"); empty unless this is the current version and comments were given. */
  threads: Map<string, PageCommentView[]>;
  commenting: boolean;
}

/** The threads on one place of the document, with the Comment control for someone who may comment; "" when comments are not shown. */
function threadsHtml(context: Context, key: string, options: { label?: string; open?: boolean } = {}): string {
  if (context.input.comments === undefined || !context.input.current) return "";
  return renderThreads(context.threads.get(key) ?? [], { shownVersion: context.input.version, canComment: context.commenting, target: key, ...options });
}

const claimHref = (context: Context, claimId: string): string => `#${escapeHtml(claimAnchor(context.input.anchor, context.input.version, claimId))}`;

/** A link to a claim's element when the ID has the shape of a claim ID; plain text otherwise. */
function claimLink(context: Context, claimId: string): string {
  return CLAIM_ID.test(claimId) ? `<a class="claim-link" href="${claimHref(context, claimId)}">${t(claimId)}</a>` : `<span class="claim-link">${t(claimId)}</span>`;
}

/** The element ID of a decision: `design-v2-decision-d3`. The list under the title links to it. */
const decisionAnchor = (context: Context, decisionId: string): string => `${context.input.anchor}-v${context.input.version}-decision-${decisionId}`;

/** The element ID of the checks table of a coding plan: `coding-plan-v2-checks`. The page's Checks section links to it. */
export const checksAnchor = (version: number): string => `coding-plan-v${version}-checks`;

function codeLines(lines: string[], startLine: number): string {
  const rows = lines.map((line, offset) => `<span class="ln">${startLine + offset}</span>${t(line)}`).join("\n");
  return `<pre><code>${rows}</code></pre>`;
}

function codeEvidence(context: Context, claim: PlanClaim, index: number, item: Extract<PlanEvidenceInput, { kind: "code" }>): string {
  const excerpt = context.excerpts.get(`${claim.id}#${index}`);
  // The excerpt's range is the one actually shown: a citation past the end of the file is clamped to its last line.
  const range = `${t(item.path)}, lines ${excerpt?.startLine ?? item.startLine}-${excerpt?.endLine ?? item.endLine}`;
  const note = item.note === undefined ? "" : `<p class="evidence-note">${t(item.note)}</p>`;
  if (excerpt?.status === "ok" && excerpt.lines !== undefined) {
    const commit = excerpt.commit === undefined ? "" : `, ${t(excerpt.commit.slice(0, 7))}`;
    const first = excerpt.startLine;
    return `<figure class="evidence evidence-code"><figcaption>${range}${commit}</figcaption>${note}${codeLines(excerpt.lines, first)}${excerpt.cut === true ? '<p class="evidence-status">Showing the first 80 lines.</p>' : ""}</figure>`;
  }
  let sentence = "Couldn't load this excerpt.";
  // The code is read after the plan is stored: the current version with no bundle yet is still loading for a while.
  const { createdAt, now } = context.input;
  const loading = excerpt === undefined && context.input.current && context.input.evidence === undefined && createdAt !== undefined && now !== undefined
    && now - Date.parse(createdAt) < EVIDENCE_LOADING_MS;
  // An older version is rendered without cited code on purpose; that is not a failure to load.
  if (loading) sentence = "Loading code… refresh in a moment.";
  else if (excerpt === undefined && !context.input.current) sentence = `Code is shown for the current version only${context.input.currentVersion === undefined ? "" : ` (v${context.input.currentVersion})`}.`;
  else if (excerpt?.status === "not_found") sentence = excerpt.commit === undefined ? "Not found in this task's repositories" : `Not found at ${t(excerpt.commit.slice(0, 7))}`;
  else if (excerpt?.status === "skipped") sentence = "Not loaded: this plan cites more than 40 excerpts.";
  return `<figure class="evidence evidence-code evidence-missing"><figcaption>${range}</figcaption>${note}<p class="evidence-status">${sentence}</p></figure>`;
}

/**
 * Who a quote credits. A planner credits a page comment by its ref ("owner (comment c1)"): the page says "Your comment"
 * or "Sam's comment", linked to the comment's thread, and never shows the ref. A ref it cannot place reads "A comment".
 */
function quoteAuthor(context: Context, author: string): string {
  const ref = commentRefInAuthor(author);
  if (ref === undefined) return t(author);
  const comment = context.input.commentRefs?.[ref];
  if (comment === undefined) return t(plainCommentAuthor(author));
  return `<a href="#comment-${escapeHtml(comment.id)}">${comment.you ? "Your comment" : `${t(comment.name)}'s comment`}</a>`;
}

async function evidenceHtml(context: Context, claim: PlanClaim, index: number, item: PlanEvidenceInput): Promise<string> {
  switch (item.kind) {
    case "code":
      return codeEvidence(context, claim, index, item);
    case "sketch":
      return `<figure class="evidence evidence-sketch"><figcaption>Sketch: not in the repository yet <span class="lang">${t(item.language)}</span></figcaption>${item.note === undefined ? "" : `<p class="evidence-note">${t(item.note)}</p>`}<pre><code>${t(item.code)}</code></pre></figure>`;
    case "quote":
      return `<blockquote class="evidence evidence-quote"><p>${t(item.text)}</p><footer>${quoteAuthor(context, item.author)}</footer></blockquote>`;
    case "flow":
    case "schema":
    case "stateMachine": {
      const { svg, text } = await renderDiagram(item);
      const alternative = `<details class="diagram-text"><summary>Show as text</summary><p>${t(text)}</p></details>`;
      // The drawing has already been cleaned and checked by the diagram renderer; it goes in as it is.
      return `<figure class="evidence evidence-diagram">${svg ?? ""}${alternative}</figure>`;
    }
  }
}

function decisionHtml(context: Context, decision: PlanDecision, withLink: boolean): string {
  const where = withLink ? `<p class="decision-claim">On claim ${claimLink(context, decision.claimId)}</p>` : "";
  const id = escapeHtml(decisionAnchor(context, decision.id));
  const note = '<p class="decision-note">Approve in Slack uses AgentX\'s answer.</p>';
  const key = `decision:${decision.id}`;
  const suggestions = context.input.current ? (context.input.suggestions ?? []).filter((suggestion) => suggestion.decisionId === decision.id) : [];
  const after = `${note}${suggestionLines(suggestions, decision.options)}${threadsHtml(context, key)}`;
  if (context.input.deciding === true && context.input.current) {
    // The owner's answer controls: one radio per option, AgentX's answer chosen to start with.
    const options = decision.options.map((option) => {
      const recommended = option.id === decision.recommended;
      const inputId = escapeHtml(`answer-${decisionAnchor(context, decision.id)}-${option.id}`);
      return `<li class="option${recommended ? " recommended" : ""}" data-option="${t(option.id)}"><input type="radio" name="answer-${t(decision.id)}" value="${t(option.id)}" id="${inputId}"${recommended ? " checked" : ""}>`
        + `<label for="${inputId}"><span class="option-label">${t(option.label)}</span>${recommended ? ' <span class="badge badge-recommended">AgentX recommends</span>' : ""} <span class="consequence">${t(option.consequence)}</span></label></li>`;
    }).join("");
    return `<div class="decision" id="${id}" data-decision="${t(decision.id)}"><fieldset class="answer"><legend><span class="decision-id">${t(decision.id)}</span> ${t(decision.question)}</legend>${where}<ul class="options">${options}</ul></fieldset>${after}</div>`;
  }
  const suggesting = context.input.current && context.input.access?.canSuggest === true;
  const mine = suggestions.find((suggestion) => suggestion.you)?.optionId;
  const options = decision.options.map((option) => {
    const recommended = option.id === decision.recommended;
    const suggest = !suggesting ? "" : ` <button type="button" class="suggest" data-decision="${t(decision.id)}" data-option="${t(option.id)}"${mine === option.id ? ' data-mine="true"' : ""} hidden>${mine === option.id ? "You suggest this · Undo" : "Suggest this"}</button>`;
    return `<li class="option${recommended ? " recommended" : ""}" data-option="${t(option.id)}"><span class="option-label">${t(option.label)}</span>${recommended ? ' <span class="badge badge-recommended">AgentX recommends</span>' : ""} <span class="consequence">${t(option.consequence)}</span>${suggest}</li>`;
  }).join("");
  return `<div class="decision" id="${id}" data-decision="${t(decision.id)}"><p class="decision-question"><span class="decision-id">${t(decision.id)}</span> ${t(decision.question)}</p>${where}<ul class="options">${options}</ul>${after}</div>`;
}

function badges(context: Context, claim: PlanClaim): string {
  const { previous } = context.input;
  const found: string[] = [];
  if (context.newIds.has(claim.id)) found.push('<span class="badge badge-new">New</span>');
  if (previous !== undefined && context.changedIds.has(claim.id)) found.push(`<span class="badge badge-changed">Changed since v${previous.version}</span>`);
  if (context.changedAfterApprovalIds.has(claim.id)) found.push('<span class="badge badge-approved-changed">Changed after approval</span>');
  return found.length === 0 ? "" : ` <span class="badges">${found.join(" ")}</span>`;
}

async function claimHtml(context: Context, claim: PlanClaim, level: number, open: boolean): Promise<string> {
  const evidence: string[] = [];
  for (const [index, item] of (claim.evidence ?? []).entries()) evidence.push(await evidenceHtml(context, claim, index, item));
  const decisions = (context.decisionsInClaims.get(claim.id) ?? []).map((decision) => decisionHtml(context, decision, false)).join("");
  const children = await claimList(context, claim.children ?? [], level + 1);
  const id = claimAnchor(context.input.anchor, context.input.version, claim.id);
  const key = `claim:${claim.id}`;
  const count = commentCountBadge(context.threads.get(key)?.length ?? 0);
  return `<details id="${escapeHtml(id)}" class="claim level-${level}"${open ? " open" : ""}><summary><span class="claim-id">${t(claim.id)}</span> <span class="claim-text">${t(claim.text)}</span>${badges(context, claim)}${count}</summary><div class="claim-body">${evidence.join("")}${decisions}${children}${threadsHtml(context, key)}</div></details>`;
}

/** The first five claims of a level, then the rest folded away. Only the first five claims of level 1 start open. */
async function claimList(context: Context, claims: PlanClaim[], level: number): Promise<string> {
  const parts: string[] = [];
  for (const claim of claims.slice(0, SHOWN)) parts.push(await claimHtml(context, claim, level, level === 1));
  const rest = claims.slice(SHOWN);
  if (rest.length > 0) {
    const more: string[] = [];
    for (const claim of rest) more.push(await claimHtml(context, claim, level, false));
    parts.push(`<details class="more"><summary>Show ${rest.length} more</summary>${more.join("")}</details>`);
  }
  return parts.join("");
}

/** Every decision, in ranked order, as a link to the decision itself; nothing when the plan has none. */
function decisionListHtml(context: Context, plan: PlanDocument): string {
  if (plan.decisions.length === 0) return '<p class="no-decisions">No decisions needed</p>';
  const items = plan.decisions.map((decision) => {
    const question = escapeHtml(cut(redactText(decision.question), DECISION_QUESTION_MAX_CHARS));
    return `<li><a class="decision-link" href="#${escapeHtml(decisionAnchor(context, decision.id))}">${t(decision.id)} \u2014 ${question} (on claim ${t(decision.claimId)})</a></li>`;
  }).join("");
  return `<nav class="decision-list" aria-label="Decisions"><p class="decision-list-title">Decisions:</p><ul>${items}</ul></nav>`;
}

function whatChangedHtml(context: Context): string {
  const { input } = context;
  const { previous, plan, version } = input;
  if (previous === undefined || version < 2) return "";
  const diff = diffPlanDocuments(previous.plan, plan);
  const now = new Map(flatten(plan.claims).map((claim) => [claim.id, claim]));
  const before = new Map(flatten(previous.plan.claims).map((claim) => [claim.id, claim]));
  const nowDecisions = new Map(plan.decisions.map((decision) => [decision.id, decision]));
  const beforeDecisions = new Map(previous.plan.decisions.map((decision) => [decision.id, decision]));
  const claimItems = (ids: string[], from: Map<string, PlanClaim>, linked: boolean): string => ids.map((id) => {
    const claim = from.get(id);
    return `<li>${linked ? claimLink(context, id) : `<span class="claim-id">${t(id)}</span>`} ${claim === undefined ? "" : t(claim.text)}</li>`;
  }).join("");
  const decisionItems = (ids: string[], from: Map<string, PlanDecision>): string => ids.map((id) => `<li><span class="decision-id">${t(id)}</span> ${from.get(id) === undefined ? "" : t(from.get(id)!.question)}</li>`).join("");
  const group = (label: string, items: string): string => (items === "" ? "" : `<h4>${label}</h4><ul>${items}</ul>`);
  const body = [
    group("Added", claimItems(diff.added, now, true)),
    group("Changed", claimItems(diff.changed, now, true)),
    group("Removed", claimItems(diff.removed, before, false)),
    group("Decisions added", decisionItems(diff.decisionsAdded, nowDecisions)),
    group("Decisions changed", decisionItems(diff.decisionsChanged, nowDecisions)),
    group("Decisions removed", decisionItems(diff.decisionsRemoved, beforeDecisions)),
  ].join("");
  return `<details class="changes"${input.openWhatChanged ? " open" : ""}><summary>What changed since v${previous.version}</summary>${body === "" ? "<p>Nothing changed in the claims or decisions.</p>" : body}</details>`;
}

function whyHtml(plan: PlanDocument): string {
  const first = plan.why[0];
  if (first === undefined) return "";
  const quotes = plan.why.map((quote) => `<blockquote class="why-quote"><p>${t(quote.text)}</p><footer>${t(quote.author)}</footer></blockquote>`).join("");
  return `<details class="why"><summary>${t(cut(redactText(first.text), WHY_SUMMARY_MAX_CHARS))}</summary>${quotes}</details>`;
}

const list = (label: string, className: string, items: string[]): string =>
  `<section class="${className}"><h3>${label}</h3><ul>${items.map((item) => `<li>${t(item)}</li>`).join("")}</ul></section>`;

/** The element ID of the Nth (1-based) Not changing item: `coding-plan-v2-nc-1`. A check that proves `nc1` links to it. */
const notChangingAnchor = (context: Context, number: number): string => `${context.input.anchor}-v${context.input.version}-nc-${number}`;

/** The Not changing items as a numbered list, each with a stable element ID, so a check's `nc<N>` can say "Not changing N" and link here. */
function notChangingHtml(context: Context, items: string[]): string {
  return `<section class="not-changing"><h3>Not changing</h3><ol>${items.map((item, index) => `<li id="${escapeHtml(notChangingAnchor(context, index + 1))}">${t(item)}</li>`).join("")}</ol></section>`;
}

/** What a check proves: a claim (linked), or `nc<N>` for the Nth Not changing item the plan has (linked); anything else is plain, escaped text. */
function provesLink(context: Context, id: string): string {
  const number = /^nc([1-9][0-9]{0,2})$/.exec(id)?.[1];
  if (number !== undefined && Number(number) <= context.input.plan.notChanging.length) {
    return `<a class="claim-link" href="#${escapeHtml(notChangingAnchor(context, Number(number)))}">Not changing ${number}</a>`;
  }
  return claimLink(context, id);
}

/** Checks with a place on this version but no row in the table: those the task knows of and the plan's own proposals. */
function otherChecks(context: Context): Array<{ id: string; label: string }> {
  const listed = new Set((context.input.checks ?? []).flatMap((check) => check.id === undefined ? [] : [check.id]));
  const out = new Map<string, string>();
  for (const check of [...(context.input.knownChecks ?? []), ...(context.input.plan.checks?.proposed ?? [])]) if (!listed.has(check.id) && !out.has(check.id)) out.set(check.id, check.label);
  return [...out].map(([id, label]) => ({ id, label }));
}

function checksHtml(context: Context): string {
  const { checks = [] } = context.input;
  const others = otherChecks(context).map((check) => threadsHtml(context, `check:${check.id}`, { label: check.label, open: false })).join("");
  if (checks.length === 0) return others === "" ? "" : `<section id="${escapeHtml(checksAnchor(context.input.version))}" class="checks"><h3>Checks</h3>${others}</section>`;
  // Class names let the stylesheet keep the short columns whole and, on a phone, stack each check as one block.
  const commentControl = (check: NonNullable<RenderPlanInput["checks"]>[number]) => check.id === undefined || !context.commenting || context.input.comments === undefined || !context.input.current ? ""
    : ` <button type="button" class="comment-open" data-target="check:${t(check.id)}" data-label="${t(check.label)}" hidden>Comment</button>`;
  const threads = checks.map((check) => check.id === undefined ? "" : threadsHtml(context, `check:${check.id}`, { label: check.label, open: false })).join("");
  const rows = checks.map((check) => `<tr><td class="check-label">${t(check.label)}${commentControl(check)}</td><td class="check-from">${check.proposed ? "Proposed" : "Project"}</td><td class="check-proves">${check.proves.length === 0 ? "None" : check.proves.map((id) => provesLink(context, id)).join(", ")}</td><td class="check-status">${t(check.status)}</td></tr>`).join("");
  return `<section id="${escapeHtml(checksAnchor(context.input.version))}" class="checks"><h3>Checks</h3><table><thead><tr><th class="check-label">Check</th><th class="check-from">From</th><th class="check-proves">Proves</th><th class="check-status">Status</th></tr></thead><tbody>${rows}</tbody></table>${threads}${others}</section>`;
}

/** "Comments on this document": the whole-document threads, and the Comment control for someone who may comment. */
function documentCommentsHtml(context: Context): string {
  const threads = threadsHtml(context, "document");
  return threads === "" ? "" : `<section class="doc-comments"><h3>Comments on this document</h3>${threads}</section>`;
}

/** Whether this version still has the place a thread is on. */
function placeExists(context: Context, key: string): boolean {
  const { plan, checks } = context.input;
  if (key === "document") return true;
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "claim") return flatten(plan.claims).some((claim) => claim.id === id);
  if (kind === "decision") return plan.decisions.some((decision) => decision.id === id);
  return (checks ?? []).some((check) => check.id === id) || otherChecks(context).some((check) => check.id === id);
}

/**
 * "Removed claims": threads whose claim, decision or check this version no longer has, each with the words it had in
 * the version the comment was written on, and the first version without it.
 */
function removedHtml(context: Context): string {
  const { input } = context;
  const entries = [...context.threads.entries()].filter(([key]) => !placeExists(context, key)).map(([key, comments]) => {
    const first = comments.find((comment) => comment.parentId === undefined) ?? comments[0]!;
    const target = first.target;
    let words = "";
    let removedIn = input.version;
    if (target.kind === "claim") {
      const written = input.plans?.get(first.version);
      const claim = written === undefined ? undefined : flatten(written.claims).find((entry) => entry.id === target.id);
      words = claim === undefined ? "" : ` ${t(claim.text)}`;
      for (let next = first.version + 1; next < input.version; next += 1) {
        const later = input.plans?.get(next);
        if (later !== undefined && !flatten(later.claims).some((entry) => entry.id === target.id)) { removedIn = next; break; }
      }
    }
    const name = target.kind === "claim" ? `<span class="claim-id">${t(target.id)}</span>` : target.kind === "document" ? "" : `${target.kind} ${t(target.id)}`;
    const threads = renderThreads(comments, { shownVersion: input.version, canComment: context.commenting, target: key, open: false });
    return `<div class="removed-claim"><p class="removed-text">${name}${words} (removed in v${removedIn})</p>${threads}</div>`;
  });
  return entries.length === 0 ? "" : `<section class="removed-claims"><h3>Removed claims</h3>${entries.join("")}</section>`;
}

/** The structured document as an HTML fragment: heading and status, what changed, why, claims, decisions, lists, checks. */
export async function renderPlanDocument(input: RenderPlanInput): Promise<string> {
  const { plan, anchor, version } = input;
  const diff = input.previous === undefined ? undefined : diffPlanDocuments(input.previous.plan, plan);
  // After approval only the claim's words count: evidence or children added by a later step are expected.
  const approvedText = new Map(flatten(input.approvedEarlier?.claims ?? []).map((claim) => [claim.id, claim.text]));
  const changedAfterApprovalIds = new Set(flatten(plan.claims).filter((claim) => approvedText.has(claim.id) && approvedText.get(claim.id) !== claim.text).map((claim) => claim.id));
  const decisionsInClaims = new Map<string, PlanDecision[]>();
  for (const decision of plan.decisions.slice(0, SHOWN)) decisionsInClaims.set(decision.claimId, [...(decisionsInClaims.get(decision.claimId) ?? []), decision]);
  // The current version shows its document's comments up to this version: on their place when it still exists, else under Removed claims.
  const shownComments = input.current ? (input.comments ?? []).filter((comment) => comment.document === input.kind && comment.version <= version) : [];
  const threads = new Map<string, PageCommentView[]>();
  for (const comment of shownComments) threads.set(targetKey(comment.target), [...(threads.get(targetKey(comment.target)) ?? []), comment]);
  const context: Context = {
    threads,
    commenting: input.access?.canComment === true,
    input,
    excerpts: new Map((input.evidence?.excerpts ?? []).map((excerpt) => [`${excerpt.claimId}#${excerpt.index}`, excerpt])),
    newIds: new Set(diff?.added ?? []),
    changedIds: new Set(diff?.changed ?? []),
    changedAfterApprovalIds,
    decisionsInClaims,
  };
  const docId = `${anchor}-v${version}`;
  const status = input.current
    ? ""
    : ` <span class="not-current">${input.currentVersion === undefined ? `This is v${version}. A newer version is the current one.` : `This is v${version}. v${input.currentVersion} is the current one.`}</span>`;
  const moreDecisions = plan.decisions.slice(SHOWN);
  const decisionsBlock = moreDecisions.length === 0
    ? ""
    : `<details class="more more-decisions"><summary>Show ${moreDecisions.length} more decisions</summary>${moreDecisions.map((decision) => decisionHtml(context, decision, true)).join("")}</details>`;
  return [
    `<section id="${escapeHtml(docId)}" class="doc doc-${escapeHtml(anchor)}">`,
    `<header class="doc-header"><h2>${KIND_LABEL[input.kind]} v${version}</h2>`,
    `<p class="doc-title">${t(plan.title)}</p>`,
    `<p class="doc-status"><span class="status ${input.approved ? "approved" : "pending"}">${input.approved ? "Approved" : "Not approved yet"}</span>${status} <a class="doc-link" href="#${escapeHtml(docId)}">Link</a></p></header>`,
    decisionListHtml(context, plan),
    whatChangedHtml(context),
    whyHtml(plan),
    `<div class="claims">${await claimList(context, plan.claims, 1)}${decisionsBlock}</div>`,
    notChangingHtml(context, plan.notChanging),
    list("Risks", "risks", plan.risks),
    checksHtml(context),
    documentCommentsHtml(context),
    removedHtml(context),
    "</section>",
  ].join("");
}
