// Task 18 (gap 4): the read-only AgentX task page. A brief Slack message links here for the full document; the page
// shows the task's documents (every version), where it stands, its checks, the current code's review findings, its pull
// requests and its history. GET only, no forms, and one small script (by nonce) that opens and scrolls to a deep
// link and, while the page is open, asks this origin's `/task/status` whether the task moved on. Every value is escaped; model and reviewer text is plain text in the page, so a link in it is never a link.
import { randomBytes } from "node:crypto";
import { redactText, taskGraphDigest, type E2EScenarioResults, type PlanDocument, type PlanEvidenceBundle, type TaskComment, type TaskPeopleChangeResult, type TaskPeopleProposal, type TaskSuggestion, type WorkItemProgressV1 } from "@agentx/contracts";
import { renderE2EScenarioRowsHtml } from "../e2e-presentation.js";
import type { TaskRole } from "../developer/task-access.js";
import type { TaskPeopleView } from "../developer/task-people.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { checksAnchor, renderPlanDocument, type PlanAnchor } from "./plan-page/render-plan.js";
import type { PlanSelfCheckView } from "../developer/plan-self-check.js";
import { renderThreads, type PageCommentView, type PageSuggestionView } from "./plan-page/comments.js";
import { TASK_PAGE_DECIDING_SCRIPT, TASK_PAGE_SCRIPT, TASK_PAGE_STYLE } from "./task-page-assets.js";
import { TASK_PAGE_API_PREFIX } from "./task-web-api.js";
import { renderTaskPeopleConfirmation, renderTaskPeoplePanel, renderTaskPeopleUnavailable } from "./task-people-page-view.js";
import {
  CSRF_COOKIE, SESSION_COOKIE, canonicalGithubUrl, csrfCookie, escapeHtml, isCsrfToken, parseCookie, safeResponse, signInLocation, type WebResponse,
} from "./web-session.js";

export type TaskDocumentKind = "requirements" | "design" | "coding plan";

/** One saved version of a document: older Markdown copies and structured plans read through the same list. */
export type TaskDocumentEntry =
  | { kind: TaskDocumentKind; version: number; approved: boolean; current: boolean; format: "markdown"; markdown: string }
  | { kind: TaskDocumentKind; version: number; approved: boolean; current: boolean; format: "structured"; plan: PlanDocument; evidence?: PlanEvidenceBundle; /** When the document was stored. */ createdAt?: string;
    /** For a coding plan: what AgentX's plan check stored beside it (or that it was not checked). */ selfCheck?: PlanSelfCheckView;
    /** For a plan stored before quotes named comments by ID: the comment each ref a quote's author names ("comment c1") stood for, from the decision that sent the comments to this document. */ commentRefs?: Record<string, string> };

export interface TaskDocumentView {
  taskId: string;
  /** The time the page was read (epoch milliseconds), so a document stored a moment ago can say its code is still loading. */
  now?: number;
  title: string;
  /** Where the task stands, in plain words. */
  status: string;
  nextStep: string;
  /** For the progress strip. */
  path: "QUICK" | "FULL";
  /** The task's state counter when the page was read; the page compares it with `/task/status` to say it moved on. */
  revision?: number;
  /** The current step's name as the progress strip spells it (`Requirements`, `Design`, `Coding plan`, `Coding`, `Checks`, `Reviews`, `Pull request`); `Complete` when every step is done (merged); empty when no step is current. */
  stage: string;
  /** Whether the reader is the task's owner. */
  role: "owner" | "reader";
  /** Every saved version of each document, oldest first within a kind. */
  documents: TaskDocumentEntry[];
  /** Documents whose saved copy failed its check: named, never shown. */
  unverified?: TaskDocumentKind[];
  /** `unclear`: the check ran but its result couldn't be told; `proposed`: AgentX proposed it in the coding plan; `proves`: the claims a structured coding plan says it proves. */
  checks: Array<{ /** The check's ID, so comments can name it. */ id?: string; label: string; passed: boolean | undefined; unclear?: true; proposed?: true; proves?: string[] }>;
  /** One plain sentence about the checks: that none apply (review only), or that the proposed ones could not be read. */
  checksNote?: string;
  /** Whether the checks have run on the current code. When left out, the page reads it from the checks' own results. */
  checksRan?: boolean;
  /** The current code's open review findings. `advisory`: the reviewer marked it advisory (never set on a security finding), so it is a note and never blocks. */
  findings: Array<{ role: "code" | "security"; text: string; origin: "INTRODUCED" | "PRE_EXISTING"; file?: string; line?: number; advisory?: true }>;
  /** Blocking findings the owner accepted for the current code, with the reason and who accepted them. */
  acceptedFindings?: Array<{ role: "code" | "security"; text: string; reason: string; owner: string; at: string }>;
  pullRequests: Array<{ url: string; number: number; state: string }>;
  /** What happened to the task's documents, newest first. `link` is a link inside this page. */
  history: Array<{ at: string; text: string; link?: string }>;
  /** What the reader may do on the page now (spec 061 slice 2). */
  access?: { role: TaskRole; canComment: boolean; canSuggest: boolean; canDecide: boolean; canAsk: boolean };
  /** Present while the task is blocked on an approved browser and API round that one retry can fix; `canRetry` is whether this reader (the owner) may make it. */
  applicationRetry?: { canRetry: boolean };
  /** The per-scenario results of the task's browser and API round (M1.3 Task 3.7), derived by the broker from evidence it verified itself, and the baseline round on the unchanged code. */
  e2eResults?: E2EScenarioResults;
  /** The task's comments, replies and AgentX replies, oldest first, as stored (redacted when written; the page escapes them). */
  comments?: TaskComment[];
  /** The suggestions that still apply to each document's current version. */
  suggestions?: TaskSuggestion[];
  /** The comments as this reader sees them (names, owner flags, "you"; no IDs of people). */
  pageComments?: PageCommentView[];
  /** The suggestions as this reader sees them, by document. */
  pageSuggestions?: Array<PageSuggestionView & { document: "requirements" | "design" | "plan" }>;
  /** The document waiting for its owner's decision, when one is. */
  waiting?: { kind: TaskDocumentKind; version: number; artifactDigest: string };
  /** Moves whenever a comment, reply or suggestion is written; the page's script compares it. */
  commentSeq?: number;
  /** The coding plan's optional checks, and whether each is chosen now. */
  optionalChecks?: Array<{ id: string; label: string; selected: boolean }>;
  /** Current approved work-item progress; readers see only the graph's public titles and states. */
  workflowDependenciesProgress?: WorkItemProgressV1[];
  /** Whether AgentX can answer comments on this task (started in Slack, and the Slack service is set up). */
  askAvailable?: boolean;
  /** One coherent current People access projection for this reader. */
  peopleRevision?: number;
  canManagePeople?: boolean;
  canTakeOwnership?: boolean;
  /** The complete private People list, attached only after the view and list agree on their revision. */
  people?: TaskPeopleView;
}

export interface TaskWebDependencies {
  /** Resolves an opaque session ID against the revocable developer sign-in store on every request. */
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  /** Must load the task through the broker and refuse (TASK_NOT_FOUND) a reader who may not see it. */
  getTaskDocumentView(caller: DeveloperCaller, taskId: string): Promise<TaskDocumentView>;
  /**
   * Where the task stands now: its state counter and the current step's name, nothing else. Must refuse a reader who may
   * not see the task exactly as `getTaskDocumentView` does. Without it, `/task/status` is not found.
   */
  getTaskFreshness?(caller: DeveloperCaller, taskId: string): Promise<TaskFreshness>;
  /** The page's JSON API (`/review/<task ID>/task/api/*`, see task-web-api.ts). Without it, those paths are not found. */
  api?(request: AdaptedHttpRequest, url: URL): Promise<WebResponse>;
  getTaskPeople?(caller: DeveloperCaller, taskId: string): Promise<TaskPeopleView>;
  getTaskPeopleRequest?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
  getTaskPeopleProposalMetadata?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleProposal>;
  getTaskPersonName?(caller: DeveloperCaller, taskId: string, personId: string): Promise<string | undefined>;
  getTaskPeopleCapabilities?(caller: DeveloperCaller, taskId: string): Promise<{ peopleRevision?: number; canManagePeople: boolean; canTakeOwnership: boolean }>;
}

/** What `/review/<task ID>/task/status` answers. */
export interface TaskFreshness { revision: number; stage: string }

/** `/review/<task ID>/task`: the task page's path; every other `/review/` path is the PR-feedback page's. */
export const TASK_PAGE = /^\/review\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/task$/i;
/** `/review/<task ID>/task/status`: where the task stands now, for the open page's "moved on" banner. */
export const TASK_STATUS = /^\/review\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/task\/status$/i;
export const TASK_PEOPLE_CONFIRMATION = new RegExp(`^/review/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/task/people/confirm/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, "i");
const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "NOT_FOUND"]);

/**
 * This page's policy: its one style element and its one script, each by nonce, and nothing else; nothing is submitted,
 * and the only request the script may make is to this origin (`/task/status`).
 */
const policy = (nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

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

const PULL_REQUEST_STATES: Record<string, string> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
const checkWords = (check: TaskDocumentView["checks"][number]) => (check.passed === true ? "Passed" : check.passed === false ? "Didn't pass" : check.unclear === true ? "Couldn't tell" : "Not run yet");

function findingItem(finding: TaskDocumentView["findings"][number]): string {
  const file = safeFindingPath(finding.file);
  const where = file === undefined ? "" : ` <code>${escapeHtml(file)}${finding.line === undefined ? "" : `:${escapeHtml(finding.line)}`}</code>`;
  return `<li><span class="tag">${finding.role === "security" ? "Security review" : "Code review"}</span> ${escapeHtml(finding.text)}${where}</li>`;
}

/** A blocking finding the owner accepted: the finding, then who accepted it and why. The owner's name and reason are redacted and escaped. */
function acceptedItem(finding: NonNullable<TaskDocumentView["acceptedFindings"]>[number]): string {
  return `<li><span class="tag">${finding.role === "security" ? "Security review" : "Code review"}</span> ${escapeHtml(redactText(finding.text))} `
    + `<span class="accepted-by">Accepted by ${escapeHtml(redactText(finding.owner))}: ${escapeHtml(redactText(finding.reason))}</span></li>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number): string => String(value).padStart(2, "0");
/** A History time as "Oct 9, 22:20 UTC"; a value that is not a time is shown as it came. */
function historyTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

/** `stage` once the pull request is merged: every step is done and none is current. */
const COMPLETE_STEP = "Complete";

/** The steps from which "No checks are set up" can be said: the checks step has been reached. */
const CHECKS_REACHED = new Set(["Checks", "Reviews", "Pull request", COMPLETE_STEP]);

const ANCHORS: Array<{ kind: TaskDocumentKind; anchor: PlanAnchor; label: string; planKind: "requirements" | "design" | "plan" }> = [
  { kind: "requirements", anchor: "requirements", label: "Requirements", planKind: "requirements" },
  { kind: "design", anchor: "design", label: "Design", planKind: "design" },
  { kind: "coding plan", anchor: "coding-plan", label: "Coding plan", planKind: "plan" },
];
/** How many claim levels each earlier document writes: requirements level 1, the design levels 1 and 2. */
const WRITTEN_LEVELS: Partial<Record<TaskDocumentKind, number>> = { requirements: 1, design: 2 };
const FULL_STEPS = ["Requirements", "Design", "Coding plan", "Coding", "Checks", "Reviews", "Pull request"];
const QUICK_STEPS = FULL_STEPS.slice(2);
const STEP_DOCUMENT: Record<string, TaskDocumentKind> = { Requirements: "requirements", Design: "design", "Coding plan": "coding plan" };

/** What the reader asked for in the link: a document and the older version they came from. Anything else is ignored. */
interface TaskPageRequest { doc?: PlanAnchor; from?: number }

function pageRequest(url: URL): TaskPageRequest {
  const doc = url.searchParams.get("doc");
  const from = url.searchParams.get("from");
  return {
    ...(doc === "requirements" || doc === "design" || doc === "coding-plan" ? { doc } : {}),
    ...(from !== null && /^[1-9][0-9]{0,8}$/.test(from) ? { from: Number(from) } : {}),
  };
}

/** The part of the link that must survive sign-in: only a known document, and only an earlier version that sign-in accepts (1 to 999). */
function signInQuery(url: URL): string {
  const doc = url.searchParams.get("doc");
  if (doc !== "requirements" && doc !== "design" && doc !== "coding-plan") return "";
  const from = url.searchParams.get("from");
  return `?doc=${doc}${from !== null && /^[1-9][0-9]{0,2}$/.test(from) ? `&from=${from}` : ""}`;
}

function markdownDocument(anchor: PlanAnchor, label: string, document: Extract<TaskDocumentEntry, { format: "markdown" }>, currentVersion: number, comments = ""): string {
  const status = document.current ? "" : ` <span class="not-current">This is v${document.version}. v${currentVersion} is the current one.</span>`;
  return `<section id="${anchor}-v${document.version}" class="doc doc-${anchor}"><header class="doc-header"><h3>${label} v${document.version}</h3>`
    + `<p class="doc-status"><span class="status ${document.approved ? "approved" : "pending"}">${document.approved ? "Approved" : "Not approved yet"}</span>${status}</p></header>`
    + `<pre class="doc-text">${escapeHtml(document.markdown)}</pre>${comments}</section>`;
}

async function documentsHtml(view: TaskDocumentView, request: TaskPageRequest): Promise<string> {
  const byKind = new Map(ANCHORS.map((entry) => [entry.kind, view.documents.filter((document) => document.kind === entry.kind).sort((left, right) => left.version - right.version)]));
  const present = ANCHORS.filter((entry) => (byKind.get(entry.kind) ?? []).length > 0);
  const requested = present.find((entry) => entry.anchor === request.doc);
  const forStep = STEP_DOCUMENT[view.stage] ?? "coding plan";
  const opened = requested ?? present.find((entry) => entry.kind === forStep) ?? present.at(-1);
  const sections: string[] = [];
  for (const entry of present) {
    const versions = byKind.get(entry.kind) ?? [];
    const currentDocument = versions.find((document) => document.current) ?? versions.at(-1)!;
    const earlier = versions.filter((document) => document !== currentDocument).reverse();
    const fromEarlier = requested === entry && request.from !== undefined && request.from < currentDocument.version;
    // A claim reworded after its approval is badged, against the nearest earlier step's approved document (only the claim
    // levels that document wrote: each document numbers its own deeper claims) and against this document's own approved version.
    let approvedEarlier: { plan: PlanDocument; depth: number } | undefined;
    for (const prior of ANCHORS.slice(0, ANCHORS.indexOf(entry)).reverse()) {
      const approved = (byKind.get(prior.kind) ?? []).filter((candidate) => candidate.approved).at(-1);
      if (approved?.format === "structured") { approvedEarlier = { plan: approved.plan, depth: WRITTEN_LEVELS[prior.kind] ?? 0 }; break; }
    }
    const approvedBefore = (document: TaskDocumentEntry): PlanDocument | undefined => {
      const approved = versions.filter((candidate) => candidate.approved && candidate.version < document.version).at(-1);
      return approved?.format === "structured" ? approved.plan : undefined;
    };
    const render = async (document: TaskDocumentEntry): Promise<string> => {
      if (document.format === "markdown") {
        // A Markdown document takes whole-document comments only, shown on its current version.
        const threads = document !== currentDocument || view.access === undefined ? "" : renderThreads(
          (view.pageComments ?? []).filter((comment) => comment.document === entry.planKind && comment.version <= document.version && comment.target.kind === "document"),
          { shownVersion: document.version, canComment: view.access.canComment, target: "document" },
        );
        return markdownDocument(entry.anchor, entry.label, document, currentDocument.version, threads === "" ? "" : `<section class="doc-comments"><h3>Comments on this document</h3>${threads}</section>`);
      }
      const before = versions[versions.indexOf(document) - 1];
      const checks = entry.kind === "coding plan" && document === currentDocument
        ? view.checks.map((check) => ({ ...(check.id === undefined ? {} : { id: check.id }), label: check.label, proposed: check.proposed === true, proves: check.proves ?? [], status: checkWords(check) })) : undefined;
      const isCurrent = document === currentDocument;
      const approvedPlan = approvedBefore(document);
      const slice2 = !isCurrent || view.access === undefined ? {} : {
        comments: view.pageComments ?? [],
        suggestions: (view.pageSuggestions ?? []).filter((suggestion) => suggestion.document === entry.planKind)
          .map(({ decisionId, optionId, name, you }) => ({ decisionId, optionId, name, you })),
        access: { canComment: view.access.canComment, canSuggest: view.access.canSuggest, canDecide: view.access.canDecide },
        deciding: view.access.canDecide && view.waiting?.kind === entry.kind && view.waiting.version === document.version,
        plans: new Map(versions.flatMap((item) => item.format === "structured" ? [[item.version, item.plan] as const] : [])),
      };
      // A quote that credits a page comment names the comment's author and links its thread, when the words are theirs.
      const quoteComments = Object.fromEntries((view.pageComments ?? []).filter((item) => item.author.kind === "person" && !item.deleted)
        .map((item) => [item.id, { name: item.author.name, you: item.author.you, text: item.text }] as const));
      return await renderPlanDocument({
        ...slice2,
        ...(Object.keys(quoteComments).length === 0 ? {} : { quoteComments }),
        ...(document.commentRefs === undefined ? {} : { commentRefs: document.commentRefs }),
        anchor: entry.anchor, kind: entry.planKind, version: document.version, approved: document.approved, current: document === currentDocument,
        currentVersion: currentDocument.version, plan: document.plan, ...(document.evidence === undefined ? {} : { evidence: document.evidence }),
        ...(document.createdAt === undefined ? {} : { createdAt: document.createdAt }), ...(view.now === undefined ? {} : { now: view.now }),
        ...(document.selfCheck === undefined ? {} : { selfCheck: document.selfCheck }),
        ...(before?.format === "structured" ? { previous: { version: before.version, plan: before.plan } } : {}),
        ...(approvedEarlier === undefined ? {} : { approvedEarlier: approvedEarlier.plan, approvedEarlierDepth: approvedEarlier.depth }),
        ...(approvedPlan === undefined ? {} : { approvedSame: approvedPlan }),
        ...(checks === undefined ? {} : { checks }),
        ...(entry.kind === "coding plan" && isCurrent && view.workflowDependenciesProgress !== undefined ? { workBreakdownProgress: view.workflowDependenciesProgress } : {}),
        ...(entry.kind === "coding plan" && isCurrent && view.optionalChecks !== undefined ? { knownChecks: view.optionalChecks.map(({ id, label }) => ({ id, label })) } : {}),
        openWhatChanged: document === currentDocument && fromEarlier,
      });
    };
    // The title is shown once, in the document's own header; the fold says only which version and whether it is approved.
    const summary = `${entry.label} v${currentDocument.version} · ${currentDocument.approved ? "approved" : "not approved yet"}`;
    // "What changed" compares the current version with the one before it, and shows only when both are structured.
    const beforeCurrent = versions[versions.indexOf(currentDocument) - 1];
    const comparison = currentDocument.format === "structured" && beforeCurrent?.format === "structured" ? beforeCurrent.version : undefined;
    const note = !fromEarlier ? ""
      : `<p class="from-note">You opened this from v${request.from}. ${comparison === undefined ? `v${currentDocument.version} is the current version.` : `Here's what changed since v${comparison}.`}</p>`;
    const older = earlier.length === 0 ? ""
      : `<details class="versions"><summary>Earlier versions (${earlier.length})</summary>${(await Promise.all(earlier.map(render))).join("")}</details>`;
    sections.push(`<section id="${entry.anchor}" class="kind" data-current="${currentDocument.version}"><details class="document"${entry === opened ? " open" : ""}>`
      + `<summary>${escapeHtml(summary)}</summary>${note}${await render(currentDocument)}${older}</details></section>`);
  }
  return sections.join("");
}

/** What each progress chip may link to; a step with no content on the page yet gets no entry and shows as plain text. */
interface ChipTargets { checks: boolean }

/** The task's pull request chip: the one pull request on GitHub, the list when there are several, nothing without one. */
function pullRequestChipTarget(view: TaskDocumentView): { href: string; external: boolean } | undefined {
  const urls = view.pullRequests.map((pullRequest) => canonicalGithubUrl(pullRequest.url));
  if (urls.length === 0 || urls.some((url) => url === undefined)) return undefined;
  return urls.length === 1 ? { href: urls[0]!, external: true } : { href: "#pull-requests", external: false };
}

function progressStrip(view: TaskDocumentView, targets: ChipTargets): string {
  const steps = view.path === "FULL" ? FULL_STEPS : QUICK_STEPS;
  const complete = view.stage === COMPLETE_STEP;
  const at = complete ? steps.length : steps.indexOf(view.stage);
  const documents = new Set(view.documents.map((document) => document.kind));
  const hasFindings = view.findings.length > 0 || (view.acceptedFindings ?? []).length > 0;
  const pullRequest = pullRequestChipTarget(view);
  const target = (step: string, index: number): { href: string; external: boolean } | undefined => {
    const entry = ANCHORS.find((candidate) => candidate.label === step);
    if (entry !== undefined) return documents.has(entry.kind) ? { href: `#${entry.anchor}`, external: false } : undefined;
    if (step === "Coding" || step === "Checks") return targets.checks ? { href: "#checks", external: false } : undefined;
    if (step === "Reviews") return at >= 0 && index <= at || hasFindings ? { href: "#findings", external: false } : undefined;
    return step === "Pull request" ? pullRequest : undefined;
  };
  const items = steps.map((step, index) => {
    const state = index === at ? "step current" : at >= 0 && index < at ? "step done" : "step";
    const link = target(step, index);
    const label = link === undefined ? escapeHtml(step)
      : `<a href="${escapeHtml(link.href)}"${link.external ? ' rel="noopener noreferrer nofollow"' : ""}>${escapeHtml(step)}</a>`;
    return `<li class="${state}"${index === at ? ' aria-current="step"' : ""}>${label}</li>`;
  });
  return `<nav aria-label="Progress"><ol class="progress">${items.join("")}</ol></nav>`;
}

/** JSON for a data island inside the page: nothing in it can close the element or start markup. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
  "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029",
})[character]!);

const KIND_ANCHOR: Record<TaskDocumentKind, PlanAnchor> = { requirements: "requirements", design: "design", "coding plan": "coding-plan" };
const KIND_LABEL: Record<TaskDocumentKind, string> = { requirements: "Requirements", design: "Design", "coding plan": "Coding plan" };

/** The waiting document, when it is a structured one on the page. */
function waitingDocument(view: TaskDocumentView): Extract<TaskDocumentEntry, { format: "structured" }> | undefined {
  const waiting = view.waiting;
  if (waiting === undefined) return undefined;
  const found = view.documents.find((document) => document.kind === waiting.kind && document.version === waiting.version);
  return found?.format === "structured" ? found : undefined;
}

/** What the page's script reads (spec 061 slice 2): who the reader is to the task, and the waiting document's decisions. Model text is redacted. */
function pageData(view: TaskDocumentView, csrf: string): Record<string, unknown> {
  const access = view.access!;
  const waiting = view.waiting;
  const structured = waitingDocument(view);
  const planKind = waiting === undefined ? undefined : ANCHORS.find((entry) => entry.kind === waiting.kind)?.planKind;
  const current = waiting === undefined ? undefined : {
    anchor: KIND_ANCHOR[waiting.kind], label: KIND_LABEL[waiting.kind], version: waiting.version, artifactDigest: waiting.artifactDigest,
    ...(structured?.plan.workBreakdown === undefined ? {} : { workBreakdownDigest: taskGraphDigest(structured.plan.workBreakdown) }),
    decisions: (structured?.plan.decisions ?? []).map((decision) => ({
      id: decision.id, question: redactText(decision.question), recommended: decision.recommended, options: decision.options.map((option) => option.id),
      labels: Object.fromEntries(decision.options.map((option) => [option.id, redactText(option.label)])),
    })),
    openCommentIds: (view.pageComments ?? []).filter((comment) => comment.author.kind === "person" && !comment.deleted && !comment.sent
      && comment.document === planKind && comment.version <= waiting.version).map((comment) => comment.id),
    optionalChecks: waiting.kind === "coding plan" ? (view.optionalChecks ?? []).map((check) => ({ id: check.id, label: redactText(check.label), selected: check.selected })) : [],
  };
  return {
    taskId: view.taskId, csrf, revision: view.revision ?? 0, role: access.role, canDecide: access.canDecide, canComment: access.canComment,
    canSuggest: access.canSuggest, canAsk: access.canAsk, canRead: true, canManagePeople: view.canManagePeople === true,
    canTakeOwnership: view.canTakeOwnership === true, ...(view.peopleRevision === undefined ? {} : { peopleRevision: view.peopleRevision }),
    ...(view.askAvailable === undefined ? {} : { askAvailable: view.askAvailable }),
    ...(current === undefined ? {} : { current }), commentSeq: view.commentSeq ?? 0,
    ...(view.applicationRetry?.canRetry === true ? { canRetry: true } : {}),
  };
}

/** The bar at the bottom of the page while a document waits: the owner's answer count and buttons (on with the script), or who decides. */
function decideBar(view: TaskDocumentView): string {
  if (view.waiting === undefined || view.access === undefined) return "";
  if (!view.access.canDecide) return '<div class="decide-bar" role="region" aria-label="Decide"><p>Only owners decide.</p></div>';
  const count = waitingDocument(view)?.plan.decisions.length ?? 0;
  // The buttons act on the waiting document, whichever one the reader has open, so each names it.
  const name = `${KIND_LABEL[view.waiting.kind].toLowerCase()} v${view.waiting.version}`;
  // Without the script the count is only a note; the script turns it into the "Next decision" control, or says all are answered.
  return '<div class="decide-bar" role="region" aria-label="Decide">'
    + `<p><button type="button" id="decide-next" hidden></button><span id="decide-count" role="status">${count === 0 ? "" : `${count} to answer`}</span></p>`
    + `<button type="button" id="decide-approve" hidden>Approve ${escapeHtml(name)}</button> <button type="button" id="decide-request-changes" hidden>Request changes to ${escapeHtml(name)}</button></div>`;
}

/** The retry of a blocked browser and API round: the owner's button (on with the script, as the decide buttons are) or who may press it. */
function applicationRetrySection(view: TaskDocumentView): string {
  if (view.applicationRetry === undefined) return "";
  return '<section id="application-retry" aria-label="Browser and API checks"><h2>Browser and API checks</h2>'
    + (view.applicationRetry.canRetry
      ? '<p>One retry approves the plan again against what is ready now and runs the checks again.</p>'
        + '<p><button type="button" id="retry-application" hidden>Retry the browser and API checks</button> <span id="retry-status" role="status" aria-live="polite"></span></p>'
        + '<p id="retry-error" class="error" role="alert" hidden></p>'
      : '<p class="muted">Only the task owner can retry these checks.</p>')
    + "</section>";
}

/** The one confirmation dialog; the page's script fills it with text only. */
function decideDialog(view: TaskDocumentView): string {
  if (view.waiting === undefined || view.access?.canDecide !== true) return "";
  const section = (id: string, heading: string, extra = "") => `<section id="${id}" hidden><h3 id="${id}-title">${heading}</h3><ul id="${id}-list"></ul>${extra}</section>`;
  return '<dialog id="decide-dialog" aria-labelledby="decide-title"><h2 id="decide-title"></h2>'
    + section("decide-changed", "Your answers that differ from AgentX's")
    + section("decide-unanswered", "Not answered yet, so AgentX's answer is used")
    + section("decide-comments", "Comments to send", '<p id="decide-cap" class="muted" hidden>You can send up to 25 comments at a time; the rest stay open for the next version.</p>')
    + section("decide-checks", "Optional checks")
    + '<label for="decide-note" id="decide-note-label">Note for AgentX (optional)</label><textarea id="decide-note" maxlength="500"></textarea>'
    + '<p id="decide-error" class="error" role="alert" hidden></p><p id="decide-status" role="status" aria-live="polite"></p>'
    + '<p class="dialog-actions"><button type="button" id="decide-submit">Approve and continue</button> <button type="button" id="decide-cancel">Cancel</button></p></dialog>';
}

async function page(view: TaskDocumentView, nonce: string, request: TaskPageRequest, csrf?: string): Promise<string> {
  const unverified = (view.unverified ?? []).map((kind) => `<p><strong>The saved ${escapeHtml(kind)} couldn't be verified, so it isn't shown.</strong></p>`).join("");
  const noDocuments = view.documents.length === 0 && unverified === "" ? "<p class=\"muted\">No document has been written yet.</p>" : "";
  const documents = await documentsHtml(view, request);
  const note = view.checksNote === undefined ? "" : `<p>${escapeHtml(view.checksNote)}</p>`;
  // The checks table is part of the current coding plan when that plan is structured; the page says so once, not twice.
  const codingPlans = view.documents.filter((document) => document.kind === "coding plan").sort((left, right) => left.version - right.version);
  const currentCodingPlan = codingPlans.find((document) => document.current) ?? codingPlans.at(-1);
  // The Checks section waits until the checks have run: before that the coding plan's own table lists them. A note (review
  // only, or the proposal could not be read) always shows. "No checks are set up" is said only once the checks step is reached.
  const ran = view.checksRan ?? view.checks.some((check) => check.passed !== undefined || check.unclear === true);
  const checks: string | undefined = !ran && view.checksNote === undefined
    ? (view.checks.length === 0 && CHECKS_REACHED.has(view.stage) ? "<p class=\"muted\">No checks are set up for this task.</p>" : undefined)
    : view.checks.length > 0 && currentCodingPlan?.format === "structured"
      ? `${note}<p><a href="#${escapeHtml(checksAnchor(currentCodingPlan.version))}">See the checks in the coding plan.</a></p>`
      : view.checks.length === 0 ? note
      : `${note}<ul>${view.checks.map((check) => `<li>${escapeHtml(check.label)}${check.proposed === true ? " (proposed by AgentX)" : ""}: ${checkWords(check)}</li>`).join("")}</ul>`;
  const introduced = view.findings.filter((finding) => finding.origin === "INTRODUCED" && finding.advisory !== true);
  const notes = view.findings.filter((finding) => finding.origin === "INTRODUCED" && finding.advisory === true);
  const older = view.findings.filter((finding) => finding.origin === "PRE_EXISTING");
  const accepted = view.acceptedFindings ?? [];
  const findings = view.findings.length === 0 && accepted.length === 0 ? "<p class=\"muted\">No review findings for the current code.</p>"
    : (view.findings.length === 0 ? "" : `<h3>Caused by this change</h3>${introduced.length === 0 ? "<p class=\"muted\">None.</p>" : `<ul>${introduced.map(findingItem).join("")}</ul>`}`
      + (notes.length === 0 ? "" : `<h3>Notes (advisory)</h3><ul>${notes.map(findingItem).join("")}</ul>`)
      + `<h3>Already in the code (advisory)</h3>${older.length === 0 ? "<p class=\"muted\">None.</p>" : `<ul>${older.map(findingItem).join("")}</ul>`}`)
      + (accepted.length === 0 ? "" : `<h3>Accepted by the owner</h3><ul>${accepted.map(acceptedItem).join("")}</ul>`);
  const pullRequests = view.pullRequests.length === 0 ? "<p class=\"muted\">No pull request yet.</p>"
    : `<ul>${view.pullRequests.map((pullRequest) => {
      const url = canonicalGithubUrl(pullRequest.url);
      const name = `Pull request #${escapeHtml(pullRequest.number)}`;
      return `<li>${url === undefined ? name : `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow">${name}</a>`}: ${PULL_REQUEST_STATES[pullRequest.state] ?? "status not known yet"}</li>`;
    }).join("")}</ul>`;
  // Newest first, whatever order the view listed them in.
  const history = [...view.history].sort((left, right) => right.at.localeCompare(left.at));
  const historyHtml = history.length === 0 ? "<p class=\"muted\">Nothing has happened yet.</p>"
    : `<ol class="history">${history.map((entry) => {
      const text = escapeHtml(entry.text);
      const linked = entry.link !== undefined && /^#[A-Za-z0-9-]+$/.test(entry.link);
      return `<li><time datetime="${escapeHtml(entry.at)}">${escapeHtml(historyTime(entry.at))}</time> ${linked ? `<a href="${escapeHtml(entry.link)}">${text}</a>` : text}</li>`;
    }).join("")}</ol>`;
  const owns = view.access === undefined ? view.role === "owner" : view.access.role === "owner";
  const role = owns ? "You're the task owner." : view.access?.canComment === true ? "You can read and comment on this task." : "You can read this task.";
  const slackOnly = view.access?.canDecide === true ? ""
    : view.access?.canComment === true ? `<p class="muted">${view.access.canSuggest ? "Only the task owner decides; you can comment and suggest." : "Only the task owner decides; you can comment."}</p>`
    : '<p class="muted">Decisions are made in Slack.</p>';
  const island = csrf === undefined || view.access === undefined ? "" : `<script type="application/json" id="agentx-page-data">${scriptJson(pageData(view, csrf))}</script>`;
  // Hidden until the script sees the task moved on; without scripts it never shows and the page reads as before.
  const movedOn = `<div id="moved-on" class="moved-on" role="status" hidden data-version="${escapeHtml(view.revision ?? 0)}" data-stage="${escapeHtml(view.stage)}"`
    + ` data-check="/review/${escapeHtml(view.taskId)}/task/status"><p>This task has moved on. Refresh to see the latest.</p>`
    + `<button type="button" id="moved-on-refresh">Refresh</button></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>AgentX task · ${escapeHtml(view.title)}</title>`
    + `<style nonce="${nonce}">${TASK_PAGE_STYLE}</style></head><body>${movedOn}`
    + `<header><h1>${escapeHtml(view.title)}</h1><p class="muted">${role}</p>${progressStrip(view, { checks: checks !== undefined && checks !== "" })}`
    + `<p><strong>${escapeHtml(view.status)}</strong></p><p>Next: ${escapeHtml(view.nextStep)}</p>${slackOnly}</header>`
    + `<main>${unverified}${documents}${noDocuments}`
    + (checks === undefined || checks === "" ? "" : `<section id="checks" aria-label="Checks"><h2>Checks</h2>${checks}</section>`)
    + (view.e2eResults === undefined ? "" : renderE2EScenarioRowsHtml(view.e2eResults, { artifactPath: (sha256) => `/review/${encodeURIComponent(view.taskId)}/task/api/e2e/artifacts/${sha256}` }))
    + applicationRetrySection(view)
    + `<section id="findings" aria-label="Review findings"><h2>Review findings</h2>${findings}</section>`
    + `<section id="pull-requests" aria-label="Pull requests"><h2>Pull requests</h2>${pullRequests}</section>`
    + (view.people === undefined ? renderTaskPeopleUnavailable() : renderTaskPeoplePanel(view.taskId, view.people))
    + `<section id="history" aria-label="History"><h2>History</h2>${historyHtml}</section>`
    + `${decideBar(view)}</main>${decideDialog(view)}${island}<script nonce="${nonce}">${TASK_PAGE_SCRIPT}</script>`
    // The deciding and commenting script comes with the data island: only for someone who can comment or decide.
    + `${island === "" ? "" : `<script nonce="${nonce}">${TASK_PAGE_DECIDING_SCRIPT}</script>`}</body></html>`;
}

function confirmationPage(taskId: string, csrf: string, capabilities: { peopleRevision?: number; canManagePeople: boolean; canTakeOwnership: boolean }, content: string): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  const data = { taskId, csrf, revision: 0, role: capabilities.canManagePeople ? "owner" : "reader", canRead: true,
    canComment: false, canSuggest: false, canDecide: false, canAsk: false, canManagePeople: capabilities.canManagePeople,
    canTakeOwnership: capabilities.canTakeOwnership, ...(capabilities.peopleRevision === undefined ? {} : { peopleRevision: capabilities.peopleRevision }), commentSeq: 0 };
  return htmlResponse(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Review People change</title>`
    + `<style nonce="${nonce}">${TASK_PAGE_STYLE}</style></head><body><main>${content}</main>`
    + `<script type="application/json" id="agentx-page-data">${scriptJson(data)}</script><script nonce="${nonce}">${TASK_PAGE_DECIDING_SCRIPT}</script></body></html>`, nonce);
}


function htmlResponse(statusCode: number, body: string, nonce: string): WebResponse {
  const response = safeResponse(statusCode, body, nonce);
  response.headers["content-security-policy"] = policy(nonce);
  return response;
}

const NO_ACCESS_HEADING = "No access";
const NO_ACCESS = "You don't have access to this task.";

/** A person's name as it reads inside a sentence: one line, redacted, cut short. messagePage escapes it. */
export function plainName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const characters = Array.from(redactText(name).replace(/[\p{Cc}\s]+/gu, " ").trim());
  if (characters.length === 0) return undefined;
  return characters.length <= 80 ? characters.join("") : `${characters.slice(0, 79).join("")}…`;
}

function messagePage(statusCode: number, heading: string, text: string): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  return htmlResponse(statusCode, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentX</title>`
    + `<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:40rem;margin:0 auto;padding:2rem 1rem}</style></head>`
    + `<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p></main></body></html>`, nonce);
}

/**
 * `/task/status`: the open page's question "did the task move on?". Same sign-in and same access rule as the page; it
 * answers only the state counter and the step's name, never cached. A signed-out reader gets 401, not a redirect.
 */
async function taskStatus(deps: TaskWebDependencies, request: AdaptedHttpRequest, taskId: string): Promise<WebResponse> {
  if (request.method !== "GET") {
    const refused = safeResponse(405, { error: "This address answers GET only." });
    refused.headers.allow = "GET";
    return refused;
  }
  const notFound = () => safeResponse(404, { error: "Not found." });
  if (deps.getTaskFreshness === undefined) return notFound();
  const sessionId = parseCookie(request.headers, SESSION_COOKIE);
  const caller = sessionId === undefined ? undefined : await deps.authenticateSession(sessionId);
  if (caller === undefined) return safeResponse(401, { error: "Sign in again." });
  try {
    const { revision, stage } = await deps.getTaskFreshness(caller, taskId);
    return safeResponse(200, { revision, stage });
  } catch (error) {
    const code = String((error as { code?: unknown })?.code);
    if (code === "TASK_ACCESS_DENIED" || HIDDEN.has(code)) return notFound();
    return safeResponse(503, { error: "Try again shortly." });
  }
}

/** The read-only task page. The session and the reader's right to see the task are checked on every request. */
export function createTaskWeb(deps: TaskWebDependencies): (request: AdaptedHttpRequest, url: URL) => Promise<WebResponse> {
  return async (request, url) => {
    if (TASK_PAGE_API_PREFIX.test(url.pathname)) return deps.api === undefined ? safeResponse(404, { error: "not_found" }) : deps.api(request, url);
    const statusOf = TASK_STATUS.exec(url.pathname)?.[1];
    if (statusOf !== undefined) return taskStatus(deps, request, statusOf);
    const confirmation = TASK_PEOPLE_CONFIRMATION.exec(url.pathname);
    const taskId = (confirmation?.[1] ?? TASK_PAGE.exec(url.pathname)?.[1])?.toLowerCase();
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
      const returnTo = confirmation === null ? `/review/${taskId}/task${signInQuery(url)}` : url.pathname;
      return { ...redirect, headers: { ...redirect.headers, "content-security-policy": policy(""), location: signInLocation(returnTo) } };
    }
    try {
      if (confirmation !== null) {
        if (deps.getTaskPeopleRequest === undefined || deps.getTaskPeopleProposalMetadata === undefined || deps.getTaskPersonName === undefined || deps.getTaskPeopleCapabilities === undefined) {
          return messagePage(404, "Not found", "This page doesn't exist.");
        }
        const requestId = confirmation[2]!.toLowerCase();
        const receipt = await deps.getTaskPeopleRequest(caller, taskId, requestId);
        if (receipt.status === "COMMITTED") return messagePage(200, "People change complete", "This People change is already complete.");
        let proposal: TaskPeopleProposal;
        try {
          proposal = await deps.getTaskPeopleProposalMetadata(caller, taskId, requestId);
        } catch (error) {
          const raced = await deps.getTaskPeopleRequest(caller, taskId, requestId);
          if (raced.status === "COMMITTED") return messagePage(200, "People change complete", "This People change is already complete.");
          throw error;
        }
        const capabilities = await deps.getTaskPeopleCapabilities(caller, taskId);
        const personName = proposal.kind === "role" && proposal.personId !== undefined ? await deps.getTaskPersonName(caller, taskId, proposal.personId) : undefined;
        if (proposal.kind === "role" && (proposal.role === undefined || personName === undefined)) throw Object.assign(new Error("unavailable"), { code: "RUNTIME_UNAVAILABLE" });
        const current = parseCookie(request.headers, CSRF_COOKIE);
        const csrf = isCsrfToken(current) ? current : randomBytes(32).toString("base64url");
        const response = confirmationPage(taskId, csrf, capabilities, renderTaskPeopleConfirmation(proposal.kind === "takeOwnership"
          ? { taskId, requestId, expiresAt: proposal.expiresAt, kind: "takeOwnership" }
          : { taskId, requestId, expiresAt: proposal.expiresAt, kind: "role", personName: personName!, role: proposal.role! }));
        response.headers["set-cookie"] = csrfCookie(csrf);
        return response;
      }
      let view = await deps.getTaskDocumentView(caller, taskId);
      if (deps.getTaskPeople !== undefined) {
        try {
          const people = await deps.getTaskPeople(caller, taskId);
          if (view.peopleRevision === people.revision) view = { ...view, people };
        } catch { /* A complete People read is optional presentation; authority stays in the page projection. */ }
      }
      const nonce = randomBytes(18).toString("base64url");
      // Someone who can comment or decide gets the CSRF cookie the page's API checks; a valid one is kept as it is.
      const acts = view.access !== undefined;
      const current = parseCookie(request.headers, CSRF_COOKIE);
      const csrf = !acts ? undefined : isCsrfToken(current) ? current : randomBytes(32).toString("base64url");
      const response = htmlResponse(200, await page(view, nonce, pageRequest(url), csrf), nonce);
      if (csrf !== undefined) response.headers["set-cookie"] = csrfCookie(csrf);
      return response;
    } catch (error) {
      const code = String((error as { code?: unknown })?.code);
      // Only a reader the broker found eligible is told whom to ask; with no name to give, the answer is the generic one.
      if (code === "TASK_ACCESS_DENIED") {
        const owners = (error as { owners?: unknown }).owners;
        const names = (Array.isArray(owners) ? owners : []).map(plainName).filter((name): name is string => name !== undefined);
        if (names.length > 0) return messagePage(403, NO_ACCESS_HEADING, `${NO_ACCESS} Ask ${names.join(" or ")} to add you.`);
      }
      // Not yours, and no such task, read the same: the page never confirms that a task exists.
      if (code === "TASK_ACCESS_DENIED" || HIDDEN.has(code)) return messagePage(404, NO_ACCESS_HEADING, NO_ACCESS);
      return messagePage(503, "Task page unavailable", "AgentX couldn't load this task right now. Try again shortly.");
    }
  };
}
