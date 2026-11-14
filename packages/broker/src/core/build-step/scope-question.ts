// A small change that grew to RISKY after the build: the pull request stays a draft, and the requester or a project approver answers one scope question with three choices: keep the extra files, remove
// them, or stop the task. The risky reviews start at once and run either way.
//
// The rules:
//   - the files and the area come from the change tier's deterministic reasons for the CURRENT head (or, when the reviewer's fixed questions raised it, the question's own words and the changed files),
//     never from a model's text; what the agent said about the change is shown only as "written by the agent, not checked";
//   - a change Rovara could not check (the reviewer did not answer, the patch was too large or unreadable) is said to be that, honestly, with Retry; it is never said to touch an area it may not touch;
//   - a change whose extra files were removed again is not asked about (the question is about what will land), but the risky reviews are still owed on its head;
//   - a change that grew to risky always has a record: when no rule names a file (risky by size, or by the reviewer's own text), the changed files are named; a missing record holds;
//   - Keep marks the pull request ready only once the risky reviews passed on the current head. Keep is a person's own act, proven to the server by an approval proof of a strong method (a fresh session,
//     as the merge press asks): a laptop API token, an AI tool (MCP), a script or a chat press cannot give it (a chat opens the web page for it); a proof of any accepted method may answer Remove or Stop.
//     Who may answer is the approvers adapter's rule, worked out on the server, never a list the caller hands in;
//   - a Keep is for exactly the files and the content it was given for: new content in the same files asks again;
//   - the hold is the draft AND Rovara's merge press: neither merges while the question is open (a person who marks the draft ready on the code host is noted; the press still refuses).
//
// The record lives beside the task (`SCOPE_QUESTION`), not in the workflow's strict `flow` record. This module is the Code API Cloud shows on the web and in Slack: `scopeQuestionOf`, `answerScopeQuestion`, `retryScopeChecks`.
import { createHash } from "node:crypto";
import { approvalProofKey, change, when, type ApprovalProof, type ApprovalRequest, type Approvers, type FlowTier, type TransactItem, type WorkflowFlow, type WorkflowSnapshot } from "@agentx/contracts";
import { TIER_QUESTIONS } from "../decisions/tier-reviewer.js";
import { TIER_REASON_CODES, planningLevelOf, skippedPlanning, tierGrowthPhrase, tierRank, tierReviewRecorded, type TierFile } from "../decisions/change-tier.js";
import { strictMethodsFor } from "../decisions/strong-methods.js";
import { boundCommits } from "../merge/change-tier-read.js";
import { inertLine } from "../proof/inert-text.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { flowIs } from "../task-flow/flow-guard.js";
import { taskKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";
import { closeLoadedTask } from "../task-flow/close.js";
import { iso, log } from "../task-flow/support.js";

export const scopeQuestionKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "SCOPE_QUESTION" });

/** The choices of the scope question. */
export const SCOPE_CHOICES = ["keep", "remove", "stop"] as const;
export type ScopeChoice = (typeof SCOPE_CHOICES)[number];

export interface ScopeFile { path: string; additions: number; deletions: number; area: string }

export interface ScopeQuestionRecord {
  taskId: string;
  /** "scope": it grew into an area a person should judge (files named); "couldnt_check": Rovara could not check it. */
  kind: "scope" | "couldnt_check";
  /** Open until answered; new files, or new content in the same files, ask again (the version moves). */
  state: "open" | "kept" | "stopped" | "superseded";
  version: number;
  headSha: string;
  /** The person's request, as plain text (what they asked for). */
  request: string;
  /** The area in plain words, from the deterministic reasons. */
  area: string;
  /** The files shown (at most 20). */
  files: ScopeFile[];
  /** A digest of every changed file of every pull request: a Keep is for exactly this change. */
  contentDigest: string;
  /** Some files could not be read (binary, renamed or mode-only): their content is not in the digest, so a Keep is for this head only (a new head asks again). */
  headBound?: true;
  /** What the agent said about the change: shown only as "written by the agent, not checked". */
  agentReason?: string;
  askedAt: string;
  answer?: { choice: ScopeChoice; personId: string; method: string; proofId: string; headSha: string; at: string };
}

/** The reasons that say Rovara could not check the change (not that it touches a sensitive area). */
const COULDNT_CHECK = new Set(["reviewer_unavailable", "reviewer_malformed", "reviewer_too_large", "reviewer_empty_patch", "reviewer_unbound", "reviewer_unanswered", "incomplete_diff", "no_diff_files", "too_many_files",
  "unreadable_content", "link_kind_unknown", "docs_unread", "path_too_long"]);
/** The reason codes that name a file a person should judge: P1's risky ones (before the first standard one), and the lighter flow's own "code the plan did not name". */
const NAMING_CODES: ReadonlySet<string> = new Set<string>([...TIER_REASON_CODES.slice(0, TIER_REASON_CODES.indexOf("more_than_lines")), "outside_plan_code"]);

/** A reason that says only that a reviewer could not run (an outage, with nothing found that must be fixed): it holds the head it happened on, and Retry may take it off. */
export const isOutageReason = (reason: { code: string; path?: string | undefined }): boolean =>
  reason.code === "reviewer_unavailable" || (reason.code === "quick_check_failed" && /did not run \((?:unavailable|refused)\)/u.test(reason.path ?? "") && !/\b[1-9]\d* must be fixed/u.test(reason.path ?? ""));

/** Whether the task grew from a small plan to risky (the case the question is for). */
export function grewToRisky(flow: WorkflowFlow | undefined): boolean {
  return skippedPlanning(flow) && planningLevelOf(flow) === "small" && flow?.tier?.level === "risky";
}

const digestOf = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex");

/** A digest of the whole change: every file of every pull request, by repository, path, earlier path, status and patch (a removed file by its status). The same path in two repositories counts twice. */
export function changeDigestOf(files: readonly TierFile[]): string {
  // Each entry as JSON (no delimiter inside a path can forge another entry), the entries sorted, the list as JSON.
  const entries = files.map((file) => JSON.stringify([file.repository ?? "", file.path, file.previousPath ?? "", file.status, file.additions, file.deletions, file.patch ?? (file.status === "removed" ? "(removed)" : "(unreadable)")])).sort();
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * What the question is about, for the current head:
 *   - the files of the deterministic risky reasons of the head's OWN diff tier (`headTier`), each with its lines and its area;
 *   - a raise by the reviewer's fixed questions: the question's fixed words and the changed files;
 *   - what could not be checked: nothing is named;
 *   - risky with no file named (by size, or by the reviewer's own text in its answer): the changed files, under the reason's plain words.
 * Undefined: nothing to ask on this head (the extra files were removed again).
 */
export function scopeOf(flow: WorkflowFlow, headTier: FlowTier, files: readonly TierFile[]): { kind: ScopeQuestionRecord["kind"]; area: string; files: ScopeFile[]; contentDigest: string; headBound?: true } | undefined {
  const fileOf = (path: string) => files.find((file) => file.path === path);
  const asFiles = (entries: ReadonlyArray<{ path: string; area: string }>) => entries.map((entry) => ({ path: inertLine(entry.path, 200), additions: fileOf(entry.path)?.additions ?? 0, deletions: fileOf(entry.path)?.deletions ?? 0, area: entry.area }));
  // A Keep is for what will land: the digest covers EVERY changed file of every pull request (repository, path, status and patch), whatever is named.
  const whole = changeDigestOf(files);
  // A file the host gives no patch for (other than a removed one) cannot be judged: the question says Rovara could not check it, never what is in it.
  const unreadable = files.some((file) => file.patch === undefined && file.status !== "removed");
  const ownTier = flow.tier?.headSha === headTier.headSha ? flow.tier : undefined;
  const reasonsHere = [...headTier.reasons, ...(ownTier?.reasons ?? [])];
  const named = reasonsHere.filter((reason) => NAMING_CODES.has(reason.code) && !COULDNT_CHECK.has(reason.code) && reason.path !== undefined && fileOf(reason.path) !== undefined);
  if (unreadable) {
    // Files with no patch and no lines (a binary, a pure rename, a mode change) can be named, and a person may keep them explicitly; a file with lines the host did not show (too large) cannot be judged.
    const unreadableFiles = files.filter((file) => file.patch === undefined && file.status !== "removed");
    if (!unreadableFiles.every((file) => file.additions + file.deletions === 0)) return { kind: "couldnt_check", area: "Rovara could not check this change", files: [], contentDigest: whole };
    const namedHere = named.filter((reason) => !unreadableFiles.some((file) => file.path === reason.path)).map((reason) => ({ path: reason.path!, area: tierGrowthPhrase({ level: "risky", reasons: [{ code: reason.code }] }, (path) => path) }));
    const listed = [...unreadableFiles.map((file) => ({ path: file.path, area: "a file Rovara could not read (binary, renamed or mode-only)" })), ...namedHere];
    return { kind: "scope", area: [...new Set(listed.map((file) => file.area))].join(", "), files: asFiles(listed).slice(0, 20), contentDigest: whole, headBound: true };
  }
  if (named.length > 0) {
    const seen = new Map<string, string>();
    for (const reason of named) if (!seen.has(reason.path!)) seen.set(reason.path!, reason.code === "outside_plan_code" ? "code the plan did not name" : tierGrowthPhrase({ level: "risky", reasons: [{ code: reason.code }] }, (path) => path));
    const all = [...seen.entries()].map(([path, area]) => ({ path, area }));
    return { kind: "scope", area: [...new Set(all.map((file) => file.area))].join(", "), files: asFiles(all).slice(0, 20), contentDigest: whole };
  }
  const changed = files.map((file) => ({ path: file.path, area: "changed file" }));
  const flagged = (ownTier?.reasons ?? []).filter((reason) => reason.code.startsWith("reviewer_") && !COULDNT_CHECK.has(reason.code) && reason.code !== "reviewer_text_instructions");
  if (flagged.length > 0) {
    const questions = flagged.map((reason) => TIER_QUESTIONS.find((question) => `reviewer_${question.id}` === reason.code)?.text).filter((text): text is string => text !== undefined);
    return {
      kind: "scope", area: questions.length === 0 ? "something the reviewer's fixed questions flagged" : `what the reviewer's fixed questions flagged: ${questions.join(" ")}`,
      files: asFiles(changed).slice(0, 20), contentDigest: whole,
    };
  }
  // Only this head's own reasons: the head's diff tier, and the reviewer's text found on this head (a sticky reason from an earlier head is about files that may be gone).
  const risky = [...headTier.reasons.filter((reason) => !COULDNT_CHECK.has(reason.code) && NAMING_CODES.has(reason.code)), ...(ownTier?.reasons ?? []).filter((reason) => reason.code === "reviewer_text_instructions")];
  if (risky.length > 0) {
    // Risky with no file a rule names (its size, or text in the reviewer's own answer): the changed files, under the reason's plain words (never the reviewer's text).
    const area = risky[0]!.code === "reviewer_text_instructions" ? "text in the reviewer's answer that tries to tell the reader what to do" : tierGrowthPhrase({ level: "risky", reasons: [{ code: risky[0]!.code }] }, (path) => path);
    return { kind: "scope", area, files: asFiles(changed).slice(0, 20), contentDigest: whole };
  }
  const couldnt = reasonsHere.some((reason) => COULDNT_CHECK.has(reason.code) || isOutageReason(reason));
  return couldnt ? { kind: "couldnt_check", area: "Rovara could not check this change", files: [], contentDigest: whole } : undefined;
}

const plainRequest = (text: string | undefined): string => inertLine((text ?? "").replace(/\s+/gu, " ").trim(), 300);

/** The question, read back (undefined: none was asked). */
export async function readScopeQuestion(deps: Pick<TaskFlowDeps, "store">, taskId: string): Promise<ScopeQuestionRecord | undefined> {
  const item = await deps.store.get(scopeQuestionKey(taskId));
  return item === undefined ? undefined : (item["question"] as unknown as ScopeQuestionRecord | undefined);
}

/**
 * The question for this pass (pure): asked, kept as it is, or superseded. New files or new content in the same files ask again (the version moves and an earlier answer no longer counts). The write is returned
 * as one item for the caller's transaction (with the review record, in the same commit), conditioned on the version read.
 */
export function planScopeQuestion(
  earlier: ScopeQuestionRecord | undefined, task: Pick<TaskRecord, "taskId" | "requestText">,
  input: { flow: WorkflowFlow; headTier: FlowTier; files: readonly TierFile[]; head: string; at: string; /** The grown tier's reviews could not run on this head (a change that grew to standard): the person sees it, with Retry. */ reviewsDown?: boolean },
): { item?: TransactItem; question?: ScopeQuestionRecord; asked: boolean } {
  let scope = grewToRisky(input.flow) ? scopeOf(input.flow, input.headTier, input.files) : undefined;
  // Grew to risky and nothing on this head is named (the extra files went before the first check): the changed files are named, so a hold always has something to answer.
  if (scope === undefined && grewToRisky(input.flow) && earlier === undefined) {
    scope = { kind: "scope", area: "a change that grew to risky on an earlier version (those files are gone now); check what will land", files: input.files.slice(0, 20).map((file) => ({ path: inertLine(file.path, 200), additions: file.additions, deletions: file.deletions, area: "changed file" })), contentDigest: changeDigestOf(input.files) };
  }
  // Grew to standard and its reviews could not run: say so, with Retry (no area is claimed).
  if (scope === undefined && input.reviewsDown === true) scope = { kind: "couldnt_check", area: "Rovara could not run the code and security reviews of this change", files: [], contentDigest: changeDigestOf(input.files) };
  let next: ScopeQuestionRecord | undefined;
  if (scope === undefined) {
    if (earlier === undefined || earlier.state !== "open") return { ...(earlier === undefined ? {} : { question: earlier }), asked: false };
    next = { ...earlier, state: "superseded", headSha: input.head };
  } else if (earlier !== undefined && earlier.kind === scope.kind && earlier.contentDigest === scope.contentDigest && earlier.state !== "superseded" && !(earlier.headBound === true && earlier.headSha !== input.head)) {
    // The same files with the same content: the answer stands, bound now to the current head.
    if (earlier.headSha === input.head) return { question: earlier, asked: false };
    next = { ...earlier, headSha: input.head };
  } else {
    next = { taskId: task.taskId, kind: scope.kind, state: "open", version: (earlier?.version ?? 0) + 1, headSha: input.head, request: plainRequest(task.requestText), area: scope.area, files: scope.files, contentDigest: scope.contentDigest, ...(scope.headBound === true ? { headBound: true as const } : {}), askedAt: input.at };
  }
  return {
    item: { kind: "put", item: { ...scopeQuestionKey(task.taskId), entityType: "SCOPE_QUESTION", question: JSON.parse(JSON.stringify(next)) as never, version: next.version }, condition: earlier === undefined ? when.absent() : when.eq("version", earlier.version) },
    question: next, asked: next.state === "open" && next.version !== earlier?.version,
  };
}

/** The tier-question record of exactly this head (any patch): the floor answered for it. */
const floorAnsweredFor = (flow: WorkflowFlow | undefined, head: string): boolean => (flow?.quickChecks ?? []).some((check) => check.detail?.startsWith(`tier_questions head=${head} `) === true);

/**
 * Whether the pull request must stay a draft (and Rovara's press refuse it). For a task that skipped planning, when the head the host shows is given: until the tier on record is for that head, the floor
 * answered for it (a small change), and the review of a grown tier ran on it. And for a change that grew to risky: until the risky reviews passed and a person kept it (a missing record holds).
 */
export function scopeHolds(flow: WorkflowFlow | undefined, question: ScopeQuestionRecord | undefined, head?: string): boolean {
  if (!skippedPlanning(flow)) return false;
  if (head !== undefined) {
    const tier = flow?.tier;
    if (tier === undefined || tier.source === "estimate" || tier.headSha !== head) return true;
    if (tier.level === "small" && !floorAnsweredFor(flow, head)) return true;
    const planned = planningLevelOf(flow) ?? "small";
    if (tierRank(tier.level) > tierRank(planned) && !tierReviewRecorded(flow, tier.level, head)) return true;
  }
  if (!grewToRisky(flow)) return false;
  if (!tierReviewRecorded(flow, "risky", flow?.tier?.headSha)) return true;
  if (question === undefined) return true;
  if (question.state === "superseded") return false;
  return question.state !== "kept";
}

/** The head a task's tier is bound to when one pull request shows `current` (several repositories: the digest of every open pull request's head, with this one's as the host shows it). */
function boundHead(workflow: WorkflowSnapshot | undefined, current: { repositoryId: string; headSha: string }): string | undefined {
  const open = (workflow?.pullRequests ?? []).filter((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN");
  // A pull request whose head Rovara never recorded cannot be bound: unbound holds.
  if (open.some((entry) => entry.headSha === undefined)) return undefined;
  const entries = open.map((entry) => ({ repositoryId: entry.repositoryId, headSha: entry.repositoryId === current.repositoryId ? current.headSha : entry.headSha ?? "", baseCommitSha: workflow?.reviewBase?.find((base) => base.repositoryId === entry.repositoryId)?.baseCommitSha }));
  return boundCommits(entries.length === 0 ? [{ repositoryId: current.repositoryId, headSha: current.headSha }] : entries).headSha;
}

/** The hold, read fresh. `current`: the pull request and the head the host shows now (merge tracking); absent: the scope rule only (the merge press, which recomputes the tier itself). A read that fails holds. */
export async function scopeHoldOf(deps: Pick<TaskFlowDeps, "store">, task: { taskId: string; workflow?: WorkflowSnapshot | undefined }, current?: { repositoryId: string; headSha: string }): Promise<boolean> {
  try {
    const head = current === undefined ? undefined : boundHead(task.workflow, current) ?? "unbound";
    return scopeHolds(task.workflow?.flow, await readScopeQuestion(deps, task.taskId), head);
  } catch {
    return skippedPlanning(task.workflow?.flow);
  }
}

/** The pull request description's banner while a change that grew to risky is held: what it grew into, from the same record as the question. Inert text; between markers so it can be replaced. */
export const SCOPE_BANNER_START = "<!-- rovara-scope:start -->";
export const SCOPE_BANNER_END = "<!-- rovara-scope:end -->";
export function scopeBanner(question: ScopeQuestionRecord | undefined, held: boolean): string {
  if (question === undefined || question.state === "superseded") return "";
  const lines = question.kind === "couldnt_check"
    ? ["> **Rovara could not check this change** (its reviewer did not answer, or a file was too large to read). It stays a draft until it is checked: retry the check from the task page, or remove or replace the file Rovara could not read."]
    : [
      `> **This grew from small to risky.** You asked for: "${question.request}".`,
      `> It also changed ${question.area}: ${question.files.map((file) => `\`${file.path}\` (+${String(file.additions)} -${String(file.deletions)})`).join(", ")}.`,
      question.headBound === true && question.state !== "kept" ? "> Rovara could not read some of these files (binary, renamed or mode-only): remove or replace the unreadable file, or keep it explicitly on the task page." : "",
      question.state === "kept" ? "> A person chose to keep these files." : held ? "> It stays a draft until a person answers on the task page (keep, remove or stop) and the code and security reviews pass." : "",
    ].filter((line) => line !== "");
  return [SCOPE_BANNER_START, ...lines, SCOPE_BANNER_END, ""].join("\n");
}

/** A body with the banner put at the top (replacing an earlier one). */
export function withScopeBanner(body: string, banner: string): string {
  const start = body.indexOf(SCOPE_BANNER_START);
  const end = body.indexOf(SCOPE_BANNER_END);
  const rest = start >= 0 && end > start ? `${body.slice(0, start)}${body.slice(end + SCOPE_BANNER_END.length).replace(/^\n/u, "")}` : body;
  return `${banner}${rest}`;
}

// ---- the Code API (Cloud shows these on the web and in Slack)

export interface ScopeQuestionView {
  question: ScopeQuestionRecord;
  /** The risky reviews on the current head: running (not recorded yet), passed, or failed (a review found something to fix, or could not run). */
  reviews: "running" | "passed" | "failed";
  /** Whether the pull request is held now. */
  held: boolean;
  /** The choices on offer (Keep needs a strong method's proof; the server checks it whatever is shown). */
  choices: ScopeChoice[];
  /** The approval request a proof must be made for, one per choice offered: the surface collects the proof (a fresh session for Keep) for exactly this request. */
  requests: Partial<Record<ScopeChoice, ApprovalRequest>>;
}

/**
 * The approval request of one answer. Keep is a high-risk request (only a strong method, a fresh session, can prove it); Remove and Stop are medium. Bound to the question's version and content, so a
 * proof for an older question answers nothing.
 */
export function scopeApprovalRequest(input: { companyId: string; task: Pick<TaskRecord, "taskId" | "project">; question: ScopeQuestionRecord; choice: ScopeChoice }): ApprovalRequest {
  return {
    companyId: input.companyId, requestId: `scope-${input.choice}-${input.task.taskId}-${String(input.question.version)}`.slice(0, 128), kind: input.choice === "keep" ? "scope_keep" : "scope_answer",
    subject: { type: "task", id: input.task.taskId }, projectName: input.task.project, revision: input.question.version,
    artifactDigest: digestOf([input.task.taskId, String(input.question.version), input.question.contentDigest, input.choice]), risk: input.choice === "keep" ? "high" : "medium",
  };
}

/** The task's scope question and where it stands. */
export async function scopeQuestionOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, taskId: string): Promise<ScopeQuestionView | undefined> {
  const task = await readTask(deps, taskId);
  const question = await readScopeQuestion(deps, taskId);
  if (task === undefined || question === undefined) return undefined;
  const flow = task.workflow?.flow;
  const head = flow?.tier?.headSha;
  const failed = (flow?.quickChecks ?? []).some((check) => !(check.detail ?? "").startsWith("tier_") && check.outcome === "failed" && (check.detail ?? "").includes(`review level=risky head=${head ?? ""}`));
  const reviews = tierReviewRecorded(flow, "risky", head) ? "passed" : failed ? "failed" : "running";
  const choices: ScopeChoice[] = question.state !== "open" ? [] : question.kind === "couldnt_check" ? ["stop"] : ["remove", "keep", "stop"];
  const requests = Object.fromEntries(choices.map((choice) => [choice, scopeApprovalRequest({ companyId: deps.companyId, task, question, choice })]));
  return { question, reviews, held: scopeHolds(flow, question), choices, requests };
}

export type ScopeAnswerResult = { status: "recorded"; question: ScopeQuestionRecord } | { status: "refused"; sentence: string };

/**
 * A person's answer, proven to the server. The proof is checked like the merge press checks its own: a method the approvers adapter lists, verified by the adapter (which also says who may answer: the
 * requester and the project approvers, by its own rule), used once. Keep needs a strong method (a fresh session): an API token, an AI tool, a script or a chat press cannot Keep, and may Remove or Stop.
 * Stop closes the task. Remove is not built yet: it is refused with what to do instead.
 */
export async function answerScopeQuestion(deps: TaskFlowDeps & { approvers: Approvers }, input: { taskId: string; choice: ScopeChoice; proof: ApprovalProof }): Promise<ScopeAnswerResult> {
  const task = await readTask(deps, input.taskId);
  const question = await readScopeQuestion(deps, input.taskId);
  if (task === undefined || question === undefined || task.closedAt !== undefined) return { status: "refused", sentence: "There is no question waiting on this task." };
  if (question.state !== "open") return { status: "refused", sentence: "This question changed or was already answered. Open the task page to see it as it is now." };
  if (input.choice === "keep" && question.kind === "couldnt_check") return { status: "refused", sentence: "Rovara could not check this change yet, so there is nothing to keep. Retry the check, or stop the task." };
  if (input.choice === "remove") return { status: "refused", sentence: "Remove isn't available yet. Push a change that takes these files out, or stop the task." };
  const request = scopeApprovalRequest({ companyId: deps.companyId, task, question, choice: input.choice });
  const requirement = await deps.approvers.requirement(request);
  const strong = input.choice === "keep" ? strictMethodsFor("approve", "high", requirement) ?? [] : undefined;
  const keepRefused = { status: "refused" as const, sentence: "Keeping these files needs a person signed in on the task page. An API token, an AI tool, a script or a chat can remove them or stop the task, but not keep them." };
  if (!requirement.methods.includes(input.proof.method)) return { status: "refused", sentence: "This answer was not proven in a way Rovara accepts." };
  if (strong !== undefined && !strong.includes(input.proof.method)) { log(deps, { event: "scope_question.keep_refused", taskId: input.taskId, method: input.proof.method }); return keepRefused; }
  const verdict = await deps.approvers.verify(request, input.proof);
  if (!verdict.approved) return { status: "refused", sentence: verdict.reason === "other_content" || verdict.reason === "other_revision" ? "This question changed while you answered. Open the task page to see it as it is now." : "Only the person who asked for this change, or a project approver, can answer this." };
  if (!requirement.methods.includes(verdict.method) || (strong !== undefined && !strong.includes(verdict.method))) return keepRefused;
  const at = iso(deps);
  const answered: ScopeQuestionRecord = { ...question, state: input.choice === "keep" ? "kept" : "stopped", answer: { choice: input.choice, personId: verdict.approver.personId, method: verdict.method, proofId: verdict.proofId, headSha: question.headSha, at } };
  const written = await deps.store.transact([
    { kind: "put", item: { ...scopeQuestionKey(input.taskId), entityType: "SCOPE_QUESTION", question: JSON.parse(JSON.stringify(answered)) as never, version: question.version }, condition: when.eq("version", question.version) },
    // A proof is used once.
    { kind: "put", item: { pk: `APPROVAL_PROOF#${approvalProofKey(input.proof)}`, sk: "USED", entityType: "APPROVAL_PROOF_USED", requestId: request.requestId, at }, condition: when.absent() },
  ]).then((result) => result.applied).catch(() => false);
  if (!written) return { status: "refused", sentence: "This question changed while you answered, or this proof was already used. Open the task page to see it as it is now." };
  log(deps, { event: "scope_question.answered", taskId: input.taskId, choice: input.choice, method: verdict.method, version: question.version });
  if (input.choice === "stop") await closeLoadedTask(deps, task, verdict.approver.personId).catch((error: unknown) => log(deps, { event: "scope_question.stop_failed", taskId: input.taskId, error: error instanceof Error ? error.name : "unknown" }));
  return { status: "recorded", question: answered };
}

/**
 * Retry after Rovara could not check the change: the reviewer outage of the current head is taken off the record (the tier it raised goes back to the head's own tier, kept in the history), and the attempts
 * of the current head that did not run are cleared, so the next pass asks again. Refused when any review of the head found something that must be fixed: that is not an outage, and a re-run must not wash it out.
 * A raise by a reviewer's answer (a yes) or by the change itself is never taken off.
 */
export async function retryScopeChecks(deps: Pick<TaskFlowDeps, "store" | "now">, taskId: string): Promise<"retrying" | "nothing_to_retry" | "refused_must_fix"> {
  const task = await readTask(deps, taskId);
  const flow = task?.workflow?.flow;
  const tier = flow?.tier;
  if (task === undefined || flow === undefined || tier === undefined) return "nothing_to_retry";
  const head = tier.headSha;
  const own = (flow.quickChecks ?? []).filter((check) => !(check.detail ?? "").startsWith("tier_") && head !== undefined && (check.detail ?? "").includes(`head=${head}`));
  if (own.some((check) => check.outcome === "failed" && /\b[1-9]\d* must be fixed/u.test(check.detail ?? ""))) return "refused_must_fix";
  const outage = tier.reasons.length > 0 && tier.reasons.every(isOutageReason);
  const failedHere = own.filter((check) => check.outcome === "failed" && /did not run/u.test(check.detail ?? ""));
  if (!outage && failedHere.length === 0) return "nothing_to_retry";
  const before = outage ? [...(flow.tierHistory ?? [])].reverse().find((entry) => entry.headSha === head && entry.level !== "risky") : undefined;
  const { grewAfterBuild: _grew, ...rest } = flow;
  void _grew;
  const next: WorkflowFlow = {
    ...(outage && before !== undefined ? { ...rest, tier: before, tierHistory: [...(flow.tierHistory ?? []), tier].slice(-20) } : flow),
    quickChecks: (flow.quickChecks ?? []).filter((check) => !failedHere.includes(check)),
  };
  const written = await deps.store.update({ key: taskKey(taskId), ops: [change.set(["workflow", "flow"], JSON.parse(JSON.stringify(next)) as never)], condition: when.and(when.notExists("closedAt"), flowIs(flow)) })
    .then((result) => result.applied).catch(() => false);
  return written ? "retrying" : "nothing_to_retry";
}
