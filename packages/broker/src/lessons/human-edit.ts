// The human-edit extractor (2026-10-30: "do not store diffs"). When a person pushed to a Rovara pull request and it merged, the code-host tap
// (the code host's capture) proves who wrote the commits and hands the changed lines over ONCE, in memory (`HumanEditInput`). This turns them into lesson drafts and drops them.
// What is kept is only the lessons the reflector makes and a link to the pull request (the lesson's `pr` citation); the diff, the hunks and the file names of the edit are not stored anywhere.
//
//  - Behind the learning switch, like every reflection (`resolveLearning`): Off and Collect read nothing and call no model.
//  - Every author is checked NOW: a canonical developer id that is no longer a member of the project, or is erased, means nothing is learned (the lines of one file are not attributed to one person, so
//    a lesson cannot keep an erased person's work out while keeping the rest). The lesson names every author, so erasing any one of them deletes it (co-written lessons are purged). A check that cannot tell THROWS, so the job is retried and never treated as "not erased".
//  - The model call is the reflector's: it goes through the customer-pays `PipelineModel` and the company's learning spend, tool-less.
//  - The task's own facts (intent, plan, who started and steered it) come from the same source as the task-end reflection; the task's send-backs, findings and close reason are that reflection's.
//  - A model error THROWS (the tap gives the claim back and the queue retries). A spend refusal, an ineligible task or a reply with no lesson is a quiet "0 candidates".
import { hostRateLimitRetryAt } from "@agentx/contracts";
import type { HumanEditExtractorPort, HumanEditInput, HumanEditJob } from "./capture-types.js";
import { currentLearningAttempt } from "./learning-deadline.js";
import { learningCaps, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { processDraftRetrying } from "./draft-retry.js";
import { newTaskFailureTally, withFailuresCountedOnce, type TaskFailureTally } from "./pause.js";
import { attachCapLadder, noteTaskHeld, readTaskHeld, reflectRepoOnly, withEdits } from "./repo-reflect.js";
import type { ProcessDeps } from "./process.js";
import { isEvalRunMark } from "./eval-run.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { EvidenceSpan, ReflectSubject } from "./reflect-input.js";
import type { LearnResult, TaskSubjectSource } from "./task-end.js";
import { buildTaskReflectSubject } from "./task-subject.js";

export interface HumanEditExtractorDeps {
  source: TaskSubjectSource;
  settings: LearningSettingsReader;
  reflect: ReflectDeps;
  process: ProcessDeps;
  /** The person's standing in the project right now (the host's own read of membership). */
  standing(orgId: string, developerId: string, project: string): Promise<"member" | "outsider">;
  /** Whether the person is erased (the record's marker or the lessons fence). THROWS when it cannot tell. */
  isErased(orgId: string, developerId: string, project: string): Promise<boolean>;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The most authors of one edit that are learned from. */
export const MAX_EDIT_AUTHORS = 5;

/** The kinds of the task's own spans a human edit's reflection keeps for context. */
const CONTEXT_KINDS: ReadonlySet<string> = new Set(["intent", "plan"]);

/** One changed file as one span of words the model can read: the place, the symbols the hunk headers named, and the changed lines (already bounded and redacted by the tap). */
function editSpan(file: HumanEditInput["files"][number], input: Pick<HumanEditInput, "authors" | "audience" | "scope">): EvidenceSpan {
  const symbols = file.symbols.length === 0 ? "" : ` (${file.symbols.join(", ")})`;
  return {
    kind: "human_edit", trust: "member", sourceKey: "human_edit",
    // A lesson built from these lines names every person who wrote any of them (a file's lines are not attributed to one person), so the erase of any one of them deletes it. The lines come from the
    // repository: they carry its audience and scope, so who may read the lesson is decided by access to that repository, as for a comment on it.
    ...(input.authors.length === 1 ? { authorId: input.authors[0]! } : {}), authorIds: input.authors, audience: input.audience, scopes: [input.scope],
    text: `A person changed ${file.path}${symbols}, +${String(file.additions)} -${String(file.deletions)}:\n${file.hunks.join("\n")}`,
  };
}

/** What the edit's own reflection came to, and the edit's lines as spans when they were usable (every author a live member): the repo-only reflection of the pull request is given those and no others. */
interface EditRun { result: { candidates: number }; edits: EvidenceSpan[]; /** Learning is off for the project: nothing more is read or called for this edit. */ off?: true }

export function createHumanEditExtractor(deps: HumanEditExtractorDeps): HumanEditExtractorPort {
  const run = async (input: HumanEditInput, tally: TaskFailureTally, onActive: () => Promise<void>): Promise<EditRun> => {
      const none: EditRun = { result: { candidates: 0 }, edits: [] };
      if (input.authors.length === 0 || input.files.length === 0) return none;
      // A lesson names every author and a provenance list holds 20 names: an edit by a crowd is not learned from (no name is ever cut).
      if (input.authors.length > MAX_EDIT_AUTHORS) return none;
      const learning = await resolveLearning(deps.settings, input.workspaceId, input.project);
      if (!modeAllows(learning.mode, "reflect")) return { ...none, off: true };
      await onActive();
      const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId, context: "human_edit" });
      if (base === undefined || base.facts.workspaceId !== input.workspaceId || base.facts.project !== input.project || base.facts.taskId !== input.taskId) return none;
      // An edit to an eval or replay run's pull request teaches nothing; refused before any author is looked up.
      if (isEvalRunMark(base.facts.rest.evalRun)) return none;
      // Every author, now. Asking all of them (no short cut) so a check that cannot tell is never hidden by an earlier answer.
      let allowed = true;
      for (const developerId of input.authors) {
        const erased = await deps.isErased(input.workspaceId, developerId, input.project);
        const standing = erased ? "outsider" : await deps.standing(input.workspaceId, developerId, input.project);
        if (erased || standing !== "member") allowed = false;
      }
      if (!allowed) return none;
      const editSpans = input.files.map((file) => editSpan(file, input));
      const context = (base.facts.rest.spans ?? []).filter((span) => CONTEXT_KINDS.has(span.kind));
      const links = [...new Set([...(base.facts.rest.links ?? []), input.link])];
      const subject: ReflectSubject = buildTaskReflectSubject({
        ...base.facts, sendBacks: [],
        rest: { ...base.facts.rest, links, spans: [...context, ...editSpans] },
      });
      // A lesson from an edit must stand on the edit: a candidate that cites no edit span is dropped (the people named come from everything read, but the lesson is about the lines).
      // This edit's failed model calls (the reflection and each draft's judge) count toward `model_failed` once, not once per call.
      const processDeps = { ...withFailuresCountedOnce(deps.process, tally), taskBudget: tally };
      // The edit's own reflection is given what is left of the task's one Public cap (the task end may have spent from it); a task with nothing left makes no call.
      const cap = learningCaps(deps.reflect.edition, deps.reflect.capsOverride).perTaskUsd;
      const room = cap === undefined ? undefined : Math.round((cap - tally.heldUsd) * 1e6) / 1e6;
      if (room !== undefined && room < 0.001) return { result: { candidates: 0 }, edits: editSpans };
      const result = await reflectSubject({ ...withFailuresCountedOnce(deps.reflect, tally), taskBudget: tally, ...(room === undefined ? {} : { capsOverride: { ...deps.reflect.capsOverride, perTaskUsd: room } }) }, { ...subject, requireEvidenceKind: "human_edit" });
      if (result.reason === "model_error" || (result.reason === "spend_refused" && currentLearningAttempt()?.fault === "retryable")) throw new Error("the model call failed");
      if (result.status !== "ok") return { result: { candidates: 0 }, edits: editSpans };
      const key = { workspaceId: input.workspaceId, project: input.project };
      let kept = 0;
      const signal = currentLearningAttempt()?.signal;
      for (const draft of result.drafts) {
        // At the deadline no new draft is started (the lesson store refuses its writes too). The model was paid for; what is cut is lost, never repeated.
        if (signal?.aborted === true) { deps.log?.("learning.drafts_cut_at_deadline", { taskId: input.taskId }); break; }
        try { await processDraftRetrying(processDeps, key, draft, { ...(deps.log === undefined ? {} : { log: (event, fields) => deps.log!(event, { taskId: input.taskId, ...fields }) }) }); kept += 1; } catch { deps.log?.("learning.draft_failed", { taskId: input.taskId }); }
      }
      return { result: { candidates: kept }, edits: editSpans };
  };

  /**
   * A pull request WITH usable human edits gets a second, separate repo-only reflection from this job: the edits, with the pull request's comments for context, under its own once-key (the task
   * end's comments reflection is its own call and always runs; curate's twin and merge rules dedupe any overlap). The task's facts are read again in full (the comments come with them). `tally` is this run's, started from what the
   * task's other runs held (Public's cap is one total per task, review). Never throws: the edit's own result stands.
   */
  const repoOnly = async (input: HumanEditInput, edits: readonly EvidenceSpan[], tally: TaskFailureTally): Promise<void> => {
    if (edits.length === 0) return;
    try {
      // The switch first, before anything is read: Off, Collect and a lessons switch that is off read nothing for this pull request.
      if (!modeAllows((await resolveLearning(deps.settings, input.workspaceId, input.project)).mode, "reflect")) return;
      const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
      if (base === undefined || base.facts.workspaceId !== input.workspaceId || base.facts.project !== input.project || base.facts.taskId !== input.taskId) return;
      const found = (base.repoChanges ?? []).find((change) => change.link.toLowerCase() === input.link.toLowerCase());
      if (found === undefined) return;
      const owned = withEdits(found, { place: input.scope, audience: input.audience, spans: edits });
      if (owned === undefined) return;
      const subject = buildTaskReflectSubject({ ...base.facts, sendBacks: [] });
      await reflectRepoOnly({ reflect: deps.reflect, process: deps.process, settings: deps.settings, ...(deps.log === undefined ? {} : { log: deps.log }) }, subject, [owned], tally, { kind: "edits" });
    } catch {
      deps.log?.("learning.repo_reflect_failed", { taskId: input.taskId });
    }
  };

  return {
    async extract(input) {
      // One tally for the whole job, started from what the task's other runs held (Public's cap is one total per task): the edit's own reflection, its curator judge and the repo-only edits reflection all draw from it.
      const tally = newTaskFailureTally();
      const cap = learningCaps(deps.reflect.edition, deps.reflect.capsOverride).perTaskUsd;
      const key = { workspaceId: input.workspaceId, project: input.project };
      // The edit's own reflection first; its model failure throws (the job is retried, and so is this).
      const ran = await run(input, tally, async () => {
        if (cap !== undefined) attachCapLadder(tally, deps.process.store, key, input.taskId, cap);
        if (cap !== undefined) { try { tally.heldUsd = await readTaskHeld(deps.process.store, key, input.taskId, cap); } catch { /* an unreadable total reads as unspent: the cap still bounds each call */ } }
      });
      if (ran.off !== true) await repoOnly(input, ran.edits, tally);
      if (cap !== undefined && ran.off !== true) { try { await noteTaskHeld(deps.process.store, key, input.taskId, tally.heldUsd, cap); } catch { /* bookkeeping only */ } }
      return ran.result;
    },
  };
}

export interface HumanEditWorkDeps {
  /** The Team record's `humanEdit.run(job, { leased: true })`: proves the authors, reads the compare live and hands it to the extractor once. */
  run(job: HumanEditJob): Promise<"handed_on" | "skipped">;
  settings: LearningSettingsReader;
}

/**
 * What the LessonsWorker runs for a human-edit message, inside the reflection's lease and attempt (`reflect-worker.ts`). The learning switch comes first, from the project alone, so a project whose learning is Off or
 * Collect never has its host read. It never throws: a fault before any model call (a read, the compare, an identity or erasure check) is `retry`, which the lease takes again only while no call has started; a fault the model
 * path marked `final` (a call that may have been billed) is not. The money rules are the reflection's: the model path writes the lease's `callStartedAt` before the call, so a redelivery after a started call is never run again.
 */
export async function learnFromHumanEdit(deps: HumanEditWorkDeps, job: HumanEditJob): Promise<LearnResult> {
  const attempt = currentLearningAttempt();
  if (attempt !== undefined) delete attempt.fault;
  try {
    const learning = await resolveLearning(deps.settings, job.repo.workspaceId, job.project);
    if (!modeAllows(learning.mode, "reflect")) return { status: "off", retry: false };
    const handed = await deps.run(job);
    return { status: handed === "handed_on" ? "reflected" : "no_facts", retry: false };
  } catch (error) {
    const retry = currentLearningAttempt() !== undefined && currentLearningAttempt()?.fault !== "final";
    // A host's rate limit (nothing was spent: the compare is read before any model call) comes back with the time the host gave, so the queue waits for it.
    const retryAt = retry ? hostRateLimitRetryAt(error) : undefined;
    return { status: "not_reflected", retry, ...(retryAt === undefined ? {} : { retryAt }) };
  }
}
