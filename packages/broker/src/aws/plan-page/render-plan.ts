// One structured plan document as an HTML fragment for the read-only task page: a ranked claim tree folded to its
// first level, with evidence, decisions, badges and what changed. A pure function of its input apart from the
// drawing of diagrams. All model text is redacted and escaped here; the markup carries class names only (the page
// owns the styles) and no inline style or event handler.
import { diffPlanDocuments, redactText, type PlanClaim, type PlanDecision, type PlanDocument, type PlanDocumentKind, type PlanEvidenceBundle, type PlanEvidenceInput } from "@agentx/contracts";
import { escapeHtml } from "../web-session.js";
import { renderDiagram } from "./diagrams.js";

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
  checks?: Array<{ label: string; proposed: boolean; proves: string[]; status: string }>;
  openWhatChanged: boolean;
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

async function evidenceHtml(context: Context, claim: PlanClaim, index: number, item: PlanEvidenceInput): Promise<string> {
  switch (item.kind) {
    case "code":
      return codeEvidence(context, claim, index, item);
    case "sketch":
      return `<figure class="evidence evidence-sketch"><figcaption>Sketch: not in the repository yet <span class="lang">${t(item.language)}</span></figcaption>${item.note === undefined ? "" : `<p class="evidence-note">${t(item.note)}</p>`}<pre><code>${t(item.code)}</code></pre></figure>`;
    case "quote":
      return `<blockquote class="evidence evidence-quote"><p>${t(item.text)}</p><footer>${t(item.author)}</footer></blockquote>`;
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
  const options = decision.options.map((option) => {
    const recommended = option.id === decision.recommended;
    return `<li class="option${recommended ? " recommended" : ""}"><span class="option-label">${t(option.label)}</span>${recommended ? ' <span class="badge badge-recommended">AgentX recommends</span>' : ""} <span class="consequence">${t(option.consequence)}</span></li>`;
  }).join("");
  const where = withLink ? `<p class="decision-claim">On claim ${claimLink(context, decision.claimId)}</p>` : "";
  return `<div class="decision" id="${escapeHtml(decisionAnchor(context, decision.id))}" data-decision="${t(decision.id)}"><p class="decision-question"><span class="decision-id">${t(decision.id)}</span> ${t(decision.question)}</p>${where}<ul class="options">${options}</ul><p class="decision-note">Approving in Slack uses AgentX's recommended answer.</p></div>`;
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
  return `<details id="${escapeHtml(id)}" class="claim level-${level}"${open ? " open" : ""}><summary><span class="claim-id">${t(claim.id)}</span> <span class="claim-text">${t(claim.text)}</span>${badges(context, claim)}</summary><div class="claim-body">${evidence.join("")}${decisions}${children}</div></details>`;
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
  if (plan.decisions.length === 0) return "";
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

function checksHtml(context: Context): string {
  const { checks } = context.input;
  if (checks === undefined || checks.length === 0) return "";
  // Class names let the stylesheet keep the short columns whole and, on a phone, stack each check as one block.
  const rows = checks.map((check) => `<tr><td class="check-label">${t(check.label)}</td><td class="check-from">${check.proposed ? "Proposed" : "Project"}</td><td class="check-proves">${check.proves.length === 0 ? "None" : check.proves.map((id) => provesLink(context, id)).join(", ")}</td><td class="check-status">${t(check.status)}</td></tr>`).join("");
  return `<section id="${escapeHtml(checksAnchor(context.input.version))}" class="checks"><h3>Checks</h3><table><thead><tr><th class="check-label">Check</th><th class="check-from">From</th><th class="check-proves">Proves</th><th class="check-status">Status</th></tr></thead><tbody>${rows}</tbody></table></section>`;
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
  const context: Context = {
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
    "</section>",
  ].join("");
}
