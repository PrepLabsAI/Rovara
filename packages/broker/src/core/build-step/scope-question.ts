// A small change that grew to RISKY after the build: the pull request stays a draft, and the requester or a project approver answers one scope question with three choices: keep the extra files, remove
// them, or stop the task. The risky reviews start at once and run either way.
//
// The rules:
//   - the files and the area come from the change tier's deterministic reasons for the CURRENT head (or, when the reviewer's fixed questions raised it, the question's own words and the changed files),
//     never from a model's text; what the agent said about the change is shown only as "written by the agent, not checked";
//   - a change Rovara could not check (the reviewer did not answer, the patch was too large or unreadable) is said to be that, honestly, with Retry; it is never said to touch an area it may not touch;
//   - a change whose extra files were removed again is not asked about (the question is about what will land), but the risky reviews are still owed on its head;
//   - Keep marks the pull request ready only once the risky reviews passed on the current head. Keep is a person's own act: a laptop API token, an AI tool (MCP), a script or a chat press cannot give it
//     (a chat opens the web page for it); any of them may answer Remove or Stop;
//   - the hold is the draft: the code host refuses to merge a draft, and so does Rovara's merge press. A person who marks it ready on the code host is seen and noted, not undone.
//
// The record lives beside the task (`SCOPE_QUESTION`), not in the workflow's strict `flow` record. This module is the Code API Cloud shows on the web and in Slack: `scopeQuestionOf`, `answerScopeQuestion`, `retryScopeChecks`.
import { change, when, type FlowTier, type WorkflowFlow, type WorkflowSnapshot } from "@agentx/contracts";
import { TIER_QUESTIONS } from "../decisions/tier-reviewer.js";
import { TIER_REASON_CODES, planningLevelOf, skippedPlanning, tierGrowthPhrase, tierReviewRecorded, type TierFile } from "../decisions/change-tier.js";
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

/** How the person answering is signed in. Only a person's own session may Keep. */
export type ScopeCredential = "session" | "api_token" | "tool" | "script" | "chat";

export interface ScopeFile { path: string; additions: number; deletions: number; area: string }

export interface ScopeQuestionRecord {
  taskId: string;
  /** "scope": it grew into a sensitive area (files named); "couldnt_check": Rovara could not check it. */
  kind: "scope" | "couldnt_check";
  /** Open until answered; a new set of files asks again (the version moves). */
  state: "open" | "kept" | "removing" | "stopped" | "superseded";
  version: number;
  headSha: string;
  /** The person's request, as plain text (what they asked for). */
  request: string;
  /** The area in plain words, from the deterministic reasons. */
  area: string;
  files: ScopeFile[];
  /** What the agent said about the change: shown only as "written by the agent, not checked". */
  agentReason?: string;
  askedAt: string;
  answer?: { choice: ScopeChoice; personId: string; method: string; credential: ScopeCredential; headSha: string; at: string };
}

/** The reasons that say Rovara could not check the change (not that it touches a sensitive area). */
const COULDNT_CHECK = new Set(["reviewer_unavailable", "reviewer_malformed", "reviewer_too_large", "reviewer_empty_patch", "reviewer_unbound", "reviewer_unanswered", "incomplete_diff", "no_diff_files", "too_many_files",
  "unreadable_content", "link_kind_unknown", "docs_unread", "path_too_long"]);
/** The reason codes that make a tier risky (P1's list, in its order: the risky ones come before the first standard one). */
const RISKY_CODES: ReadonlySet<string> = new Set<string>(TIER_REASON_CODES.slice(0, TIER_REASON_CODES.indexOf("more_than_lines")));

/** A reason that says only that a reviewer could not run (an outage): it holds the head it happened on, and Retry may take it off. */
export const isOutageReason = (reason: { code: string; path?: string | undefined }): boolean =>
  reason.code === "reviewer_unavailable" || (reason.code === "quick_check_failed" && /did not run \((?:unavailable|refused)\)/u.test(reason.path ?? ""));

/** Whether the task grew from a small plan to risky (the case the question is for). */
export function grewToRisky(flow: WorkflowFlow | undefined): boolean {
  return skippedPlanning(flow) && planningLevelOf(flow) === "small" && flow?.tier?.level === "risky";
}

/**
 * What the question is about, for the current head: the files of the deterministic risky reasons of the head's OWN diff tier (`headTier`), each with its lines and its area; a raise by the reviewer's fixed
 * questions names the question (its fixed words) and the changed files; a raise for what could not be checked names nothing. Undefined: nothing to ask (the extra files were removed again).
 */
export function scopeOf(flow: WorkflowFlow, headTier: FlowTier, files: readonly TierFile[]): { kind: ScopeQuestionRecord["kind"]; area: string; files: ScopeFile[] } | undefined {
  const linesOf = (path: string) => files.find((file) => file.path === path) ?? { additions: 0, deletions: 0 };
  const named = headTier.reasons.filter((reason) => RISKY_CODES.has(reason.code) && !COULDNT_CHECK.has(reason.code) && reason.path !== undefined);
  if (named.length > 0) {
    const seen = new Set<string>();
    const out: ScopeFile[] = [];
    for (const reason of named) {
      if (seen.has(reason.path!)) continue;
      seen.add(reason.path!);
      const counted = linesOf(reason.path!);
      out.push({ path: inertLine(reason.path!, 200), additions: counted.additions, deletions: counted.deletions, area: tierGrowthPhrase({ level: "risky", reasons: [{ code: reason.code }] }, (path) => path) });
    }
    return { kind: "scope", area: [...new Set(out.map((file) => file.area))].join(", "), files: out.slice(0, 20) };
  }
  // Raised by the reviewer's fixed questions on this head: the question's own words (never the reviewer's reason) and the changed files.
  const tier = flow.tier;
  const flagged = (tier?.headSha === headTier.headSha ? tier?.reasons ?? [] : []).filter((reason) => reason.code.startsWith("reviewer_") && !COULDNT_CHECK.has(reason.code) && reason.code !== "reviewer_text_instructions");
  if (flagged.length > 0) {
    const questions = flagged.map((reason) => TIER_QUESTIONS.find((question) => `reviewer_${question.id}` === reason.code)?.text).filter((text): text is string => text !== undefined);
    return {
      kind: "scope", area: questions.length === 0 ? "something the reviewer's fixed questions flagged" : `what the reviewer's fixed questions flagged: ${questions.join(" ")}`,
      files: files.slice(0, 20).map((file) => ({ path: inertLine(file.path, 200), additions: file.additions, deletions: file.deletions, area: "changed file" })),
    };
  }
  const couldnt = [...headTier.reasons, ...(tier?.headSha === headTier.headSha ? tier?.reasons ?? [] : [])].some((reason) => COULDNT_CHECK.has(reason.code));
  return couldnt ? { kind: "couldnt_check", area: "Rovara could not check this change", files: [] } : undefined;
}

const plainRequest = (text: string | undefined): string => inertLine((text ?? "").replace(/\s+/gu, " ").trim(), 300);

/** The question, read back (undefined: none was asked). */
export async function readScopeQuestion(deps: Pick<TaskFlowDeps, "store">, taskId: string): Promise<ScopeQuestionRecord | undefined> {
  const item = await deps.store.get(scopeQuestionKey(taskId));
  return item === undefined ? undefined : (item["question"] as unknown as ScopeQuestionRecord | undefined);
}

/**
 * The question asked (or kept as it is) for this pass of the lighter flow's checks. A new set of files on a later head asks again: the version moves and the earlier answer no longer counts. A head whose
 * extra files are gone supersedes an open question. Written with a condition on the version read, so two passes cannot both ask.
 */
export async function askScopeQuestion(deps: Pick<TaskFlowDeps, "store" | "now">, task: TaskRecord, input: { flow: WorkflowFlow; headTier: FlowTier; files: readonly TierFile[]; head: string; at: string }): Promise<{ asked: boolean; question?: ScopeQuestionRecord }> {
  const earlier = await readScopeQuestion(deps, task.taskId);
  const scope = grewToRisky(input.flow) ? scopeOf(input.flow, input.headTier, input.files) : undefined;
  const sameFiles = (left: readonly ScopeFile[], right: readonly ScopeFile[]) => JSON.stringify(left.map((file) => file.path).sort()) === JSON.stringify(right.map((file) => file.path).sort());
  let next: ScopeQuestionRecord | undefined;
  if (scope === undefined) {
    if (earlier === undefined || earlier.state !== "open") return earlier === undefined ? { asked: false } : { asked: false, question: earlier };
    next = { ...earlier, state: "superseded", headSha: input.head };
  } else if (earlier !== undefined && earlier.kind === scope.kind && sameFiles(earlier.files, scope.files) && earlier.state !== "superseded") {
    // The same question: its answer stands (a Keep is for these files), bound now to the current head.
    if (earlier.headSha === input.head) return { asked: false, question: earlier };
    next = { ...earlier, headSha: input.head };
  } else {
    next = {
      taskId: task.taskId, kind: scope.kind, state: "open", version: (earlier?.version ?? 0) + 1, headSha: input.head, request: plainRequest(task.requestText), area: scope.area, files: scope.files, askedAt: input.at,
    };
  }
  const written = await deps.store.put({
    item: { ...scopeQuestionKey(task.taskId), entityType: "SCOPE_QUESTION", question: JSON.parse(JSON.stringify(next)) as never, version: next.version },
    condition: earlier === undefined ? when.absent() : when.eq("version", earlier.version),
  }).then((result) => result.applied).catch(() => false);
  return { asked: written && next.state === "open" && next.version !== earlier?.version, ...(written ? { question: next } : earlier === undefined ? {} : { question: earlier }) };
}

/** Whether the pull request must stay a draft: the task grew to risky and either its question is not answered with Keep, or the risky reviews have not passed on the current head. */
export function scopeHolds(flow: WorkflowFlow | undefined, question: ScopeQuestionRecord | undefined): boolean {
  if (!grewToRisky(flow)) return false;
  const head = flow?.tier?.headSha;
  if (!tierReviewRecorded(flow, "risky", head)) return true;
  if (question === undefined || question.state === "superseded") return false;
  return question.state !== "kept";
}

/** The hold for merge tracking (a draft is not marked ready while it holds). Read fresh; a read that fails holds. */
export async function scopeHoldOf(deps: Pick<TaskFlowDeps, "store">, task: { taskId: string; workflow?: WorkflowSnapshot | undefined }): Promise<boolean> {
  try {
    return scopeHolds(task.workflow?.flow, await readScopeQuestion(deps, task.taskId));
  } catch {
    return grewToRisky(task.workflow?.flow);
  }
}

/** The pull request description's banner while a change that grew to risky is held: what it grew into, from the same record as the question. Inert text; between markers so it can be replaced. */
export const SCOPE_BANNER_START = "<!-- rovara-scope:start -->";
export const SCOPE_BANNER_END = "<!-- rovara-scope:end -->";
export function scopeBanner(question: ScopeQuestionRecord | undefined, held: boolean): string {
  if (question === undefined || question.state === "superseded") return "";
  const lines = question.kind === "couldnt_check"
    ? ["> **Rovara could not check this change** (its reviewer did not answer, or the change could not be read in full). It stays a draft until it is checked. Retry from the task page."]
    : [
      `> **This grew from small to risky.** You asked for: "${question.request}".`,
      `> It also changed ${question.area}: ${question.files.map((file) => `\`${file.path}\` (+${String(file.additions)} -${String(file.deletions)})`).join(", ")}.`,
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
  /** Whether the pull request is held as a draft now. */
  held: boolean;
  /** The choices this caller may make (Keep only from a person's own session). */
  choices: ScopeChoice[];
}

/** The task's scope question and where it stands, for a caller signed in as `credential`. */
export async function scopeQuestionOf(deps: Pick<TaskFlowDeps, "store">, taskId: string, credential: ScopeCredential = "session"): Promise<ScopeQuestionView | undefined> {
  const task = await readTask(deps, taskId);
  const question = await readScopeQuestion(deps, taskId);
  if (task === undefined || question === undefined) return undefined;
  const flow = task.workflow?.flow;
  const head = flow?.tier?.headSha;
  const failed = (flow?.quickChecks ?? []).some((check) => !(check.detail ?? "").startsWith("tier_") && check.outcome === "failed" && (check.detail ?? "").includes(`review level=risky head=${head ?? ""}`));
  const reviews = tierReviewRecorded(flow, "risky", head) ? "passed" : failed ? "failed" : "running";
  const open = question.state === "open";
  const choices: ScopeChoice[] = !open ? [] : question.kind === "couldnt_check" ? ["stop"] : credential === "session" ? ["remove", "keep", "stop"] : ["remove", "stop"];
  return { question, reviews, held: scopeHolds(flow, question), choices };
}

export type ScopeAnswerResult = { status: "recorded"; question: ScopeQuestionRecord } | { status: "refused"; sentence: string };

/**
 * A person's answer. Who may answer: the task's requester and the project approvers the caller names. Keep needs a person's own session (an API token, an AI tool, a script or a chat cannot Keep). Stop closes
 * the task. Remove is not built yet: it is refused with what to do instead. The answer is bound to the head and the version it was given for: a newer question is not answered by it.
 */
export async function answerScopeQuestion(deps: TaskFlowDeps, input: { taskId: string; version: number; choice: ScopeChoice; by: { personId: string; method: string; credential: ScopeCredential }; approvers?: readonly string[] }): Promise<ScopeAnswerResult> {
  const task = await readTask(deps, input.taskId);
  const question = await readScopeQuestion(deps, input.taskId);
  if (task === undefined || question === undefined || task.closedAt !== undefined) return { status: "refused", sentence: "There is no question waiting on this task." };
  if (question.version !== input.version || question.state !== "open") return { status: "refused", sentence: "This question changed or was already answered. Open the task page to see it as it is now." };
  if (input.by.personId !== task.developerId && !(input.approvers ?? []).includes(input.by.personId)) return { status: "refused", sentence: "Only the person who asked for this change, or a project approver, can answer this." };
  if (input.choice === "keep" && question.kind === "couldnt_check") return { status: "refused", sentence: "Rovara could not check this change yet, so there is nothing to keep. Retry the check, or stop the task." };
  if (input.choice === "keep" && input.by.credential !== "session") {
    log(deps, { event: "scope_question.keep_refused", taskId: input.taskId, credential: input.by.credential });
    return { status: "refused", sentence: "Keeping these files needs a person on the task page. An API token, an AI tool, a script or a chat can remove them or stop the task, but not keep them." };
  }
  if (input.choice === "remove") return { status: "refused", sentence: "Remove isn't available yet. Push a change that takes these files out, or stop the task." };
  const at = iso(deps);
  const answered: ScopeQuestionRecord = { ...question, state: input.choice === "keep" ? "kept" : "stopped", answer: { choice: input.choice, personId: input.by.personId, method: input.by.method, credential: input.by.credential, headSha: question.headSha, at } };
  const written = await deps.store.put({
    item: { ...scopeQuestionKey(input.taskId), entityType: "SCOPE_QUESTION", question: JSON.parse(JSON.stringify(answered)) as never, version: question.version },
    condition: when.and(when.eq("version", question.version)),
  }).then((result) => result.applied).catch(() => false);
  if (!written) return { status: "refused", sentence: "This question changed while you answered. Open the task page to see it as it is now." };
  log(deps, { event: "scope_question.answered", taskId: input.taskId, choice: input.choice, method: input.by.method, credential: input.by.credential, version: question.version });
  if (input.choice === "stop") await closeLoadedTask(deps, task, input.by.personId).catch((error: unknown) => log(deps, { event: "scope_question.stop_failed", taskId: input.taskId, error: error instanceof Error ? error.name : "unknown" }));
  return { status: "recorded", question: answered };
}

/**
 * Retry after Rovara could not check the change: the reviewer outage of the current head is taken off the record (the tier it raised goes back to the head's own tier, kept in the history), and the failed
 * attempts of the current head are cleared, so the next pass asks the reviewer again. A raise by a reviewer's answer (a yes) or by the change itself is never taken off.
 */
export async function retryScopeChecks(deps: Pick<TaskFlowDeps, "store" | "now">, taskId: string): Promise<"retrying" | "nothing_to_retry"> {
  const task = await readTask(deps, taskId);
  const flow = task?.workflow?.flow;
  const tier = flow?.tier;
  if (task === undefined || flow === undefined || tier === undefined) return "nothing_to_retry";
  const outage = tier.reasons.length > 0 && tier.reasons.every(isOutageReason);
  const head = tier.headSha;
  const failedHere = (flow.quickChecks ?? []).filter((check) => !(check.detail ?? "").startsWith("tier_") && check.outcome === "failed" && /did not run/u.test(check.detail ?? "") && head !== undefined && (check.detail ?? "").includes(`head=${head}`));
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
