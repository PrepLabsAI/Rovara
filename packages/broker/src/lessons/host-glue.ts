import { workspaceKeys } from "../core/task-flow/workspace-location.js";
import { markLessonsUnderQuestion } from "./revert-question.js";
// The parts of joining the lessons library to the task flow that every host does the same way, whether one person on a laptop (`local/app/lessons.ts`) or a company on a deployed install
// (`core-host/lessons.ts`). Each is built for ONE company: a task, a load record or a queue message of another company is not this company's, and is ignored.
//   loading     at the dispatch of a step: the lessons that fit the task, the load record (so the worker's report is applied to this stage only) and which tasks used which lessons;
//   reports     the worker's load report, applied to the manifest its dispatch recorded;
//   the PR      the "Lessons used" section of a task's pull request and the numbered list a comment refers to;
//   capture     a merged or closed task puts one message of ids on the `lessons-reflect` queue; a pass reads it, takes a lease and reflects. So does a person's send-back of a task that is still open
//               (`noteSentBack`, learn on send-back): its correction can help the next task before this one ends;
//   upkeep      once a day per project: expired lessons swept, stable trials promoted.
// Nothing here makes a model call by itself: the reflection worker does, through the runtime's model, which the library gates on the switch.
import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_CONTEXT_FEATURE, KNOWLEDGE_STAGE_PARTS, LEARNED_CONTEXT_FEATURE, LESSONS_WORKER_DEADLINE_SECONDS, ROVARA_SKILLS_FEATURE, codeRepositoriesOf, companyScoped, knowledgeProposalsOfProgress, knowledgeUseReportOfProgress, learnedLoadReportOfProgress,
  type KnowledgeContext, type LearnedContext, type ObjectStorage, type OrgId, type QueueService, type RovaraSkillFile,
} from "@agentx/contracts";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";

import { readOwnerFindingNotes } from "../core/task-flow/owner-note.js";
import { readTask } from "../core/task-flow/reads.js";
import { fromDocument, type TaskPointerRecord, type TaskRecord } from "../core/task-flow/records.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { loadWorkflowDocument } from "../developer/plan-document-reader.js";
import type { LessonsUsedSection } from "../core/proof/pull-request-body.js";
import type { CodeMilestoneHandler } from "../core/milestones/milestones.js";
import { applyLoadReport } from "./counters.js";
import type { FadePorts } from "./expiry.js";
import { runAreaChecks, type AreaCheckPorts } from "./area-check.js";
import { logTaskCorrections } from "./correction-log.js";
import type { Lesson } from "./types.js";
import { loadAnswerBriefing } from "./answer-briefing.js";
import { learnedContextForDispatch, lessonsAndPickedForDispatch, loadPullForStage } from "./load.js";
import { buildKnowledgeContext, deliveryRecordOf, pathsNamedIn, type KnowledgeSources } from "./knowledge-brief.js";
import { knowledgeGivenItem, recordKnowledgeUseReport } from "./knowledge-use.js";
import { modeAllows, resolveLearning } from "./policy.js";
import { proposeLimits } from "./knowledge-limits.js";
import { proposeKnowledge } from "./propose.js";
import { liveSkillsForStep } from "./skills.js";
import type { LessonsRuntime } from "./runtime.js";
import { documentReflectClaims } from "./reflect-claims.js";
import { SEND_BACK_REFLECTIONS_MAX, reflectQueueOf, queueReflectQueue, queueReflectVisibility, sendBackRequestId } from "./reflect-queue.js";
import { isHumanSendBack } from "./human-send-backs.js";
import { NO_REASON_TEXT } from "./task-subject.js";
import { retryDelayFor, runReflectMessage, type ReflectWorkerDeps } from "./reflect-worker.js";
import { createHumanEditExtractor, learnFromHumanEdit } from "./human-edit.js";
import { recordedHeadOf } from "../core/build-step/head-check.js";
import { createHumanEditProducer } from "./human-edit-producer.js";
import { createHumanEditRun, type HumanEditRunDeps } from "./human-edit-work.js";
import type { HumanEditSink } from "../core/merge/seams.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskEndOutcome, type TaskLearningDeps } from "./task-end.js";
import { lessonsUsedReaderOver, lessonsUsedSection, type LessonsUsedSummary, type RepositoryVisibility } from "./used-in-pr.js";
import { pausedKindsFor } from "./paused-kinds.js";
import { planLoadFacts } from "./plan-facts.js";
import { LESSON_USE_KEEP_SECONDS } from "./use-count.js";
import { lessonLoadRefItem, lessonUseItem } from "./load-record.js";
import type { OutcomeRowReader } from "./task-outcome-rows.js";

/** The longest a step's dispatch waits for the loader: a slow load sends nothing, and the step runs as it would without lessons. */
export const LESSON_LOAD_DEADLINE_MS = 2_500;
/** The messages one pass takes off the reflection queue. */
export const REFLECT_PER_PASS = 2;
/** The use rows ("used in N tasks", `use-count.ts`) are kept as long as that module counts them. */
const USE_RECORD_KEEP_SECONDS = LESSON_USE_KEEP_SECONDS;
export const INTENT_REQUEST_CHARS = 600;

/** The workflow modes that carry lessons, and the lesson stage each is. Every other mode (the checks, a publication) carries none. */
const STAGES: Readonly<Record<string, "UNDERSTAND" | "PLAN" | "IMPLEMENT" | "PLAN_CRITIQUE" | "REVIEW">> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", PLAN_CRITIQUE: "PLAN_CRITIQUE", REVIEW: "REVIEW" };
/** The longest a step's dispatch waits for the measured facts or the look-up: past it the step goes without them (the lessons are never held up by them). */
const KNOWLEDGE_EXTRAS_MS = 900;
/** The correction text of a fix round is used only to rank lessons: this many characters of it. */
const FIX_TEXT_CHARS = 2_000;

/** What the loader is told about a task besides its title: a summary of its latest plan and the files the plan names (the same read for the loader and for "would have applied", `recent-tasks.ts`). */
export async function taskPlanFacts(readText: ReturnType<typeof textReaderOf>, task: Pick<TaskRecord, "workflow">): Promise<{ summary: string; files: string[] } | undefined> {
  const artifact = task.workflow?.artifacts.filter((entry) => entry.type === "plan").sort((a, b) => a.version - b.version).at(-1);
  if (artifact === undefined) return undefined;
  const loaded = await loadWorkflowDocument(readText, artifact, {});
  if (loaded === undefined) return undefined;
  if (loaded.format === "structured") return planLoadFacts(loaded.plan);
  // A Markdown plan: its first words are the summary, and the files it names in words are the files.
  return planLoadFacts({ title: loaded.markdown.split("\n", 1)[0] ?? "", claims: [{ text: loaded.markdown.slice(0, 20_000) }] } as unknown as Parameters<typeof planLoadFacts>[0]);
}

export interface LessonsHostInput {
  flow: TaskFlowDeps;
  runtime: LessonsRuntime;
  companyId: OrgId;
  blobs: ObjectStorage;
  queues: QueueService;
  /** Whether lessons are on for this company now (read at every ask). */
  enabled: () => boolean;
  /** Lead 4 L4-AK2: where measured facts and skill names come from, when this install has them (the base's known-flaky list). Absent: the briefing carries lessons and the look-up only. */
  knowledge?: KnowledgeSources | undefined;
  /** What the reflector reads of an ended task (its record, the people's words, its outcome rows). */
  sources: { source: TaskLearningDeps["source"]; rows: OutcomeRowReader };
  /** Whether the repositories a pull request of the project is in are public, private or unknown (for which lessons a description may name). */
  visibility: (project: string) => Promise<RepositoryVisibility>;
  /**
   * Learn from a person's edits to Rovara's pull requests (L4-LM1c). With it the host takes the tracking pass's push notice (`noteHumanEdit`) and the worker runs the queued job; without it a human-edit message is
   * answered "unavailable" as before and nothing is produced. `repos` and `personOf` are the company's own (a task's repository as its project pins it; a code host account's member by the host's stable id);
   * `standing` and `isErased` are the extractor's checks of each author now.
   */
  humanEdit?: {
    repos: HumanEditRunDeps["repos"];
    personOf: HumanEditRunDeps["personOf"];
    standing(orgId: string, developerId: string, project: string): Promise<"member" | "outsider">;
    isErased(orgId: string, developerId: string, project: string): Promise<boolean>;
    /** Whether this install can place a code host account as a member at all (its identity point links accounts). False: no push is read or queued, since no author could ever be named. */
    canPlaceAuthors(): boolean;
  } | undefined;
  /** The nightly area checks' reads of the project's repositories (`area-check.ts`). Absent: the checks do not run. */
  areaChecks?: AreaCheckPorts;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/** What a revert says of its change: the commit that reverted it and the files it touched (undefined: not known). */
export interface RevertedChange { via: string; files: readonly string[] | undefined }

export interface LessonsHost {
  learnedFor(input: { workspaceId: string; operationId: string; workflowMode: string | undefined; features: readonly string[]; fix?: { text: string } | undefined }): Promise<{ learnedContext?: LearnedContext; knowledgeContext?: KnowledgeContext; rovaraSkills?: RovaraSkillFile[] }>;
  /** Lead 4 L4-AK2b: the team knowledge briefing for the answer a person asks of one project (the same lessons read path, facts and "more" line as a coding step; whole-project readers only). Undefined when learning is off here, nothing fits, or anything cannot be read in time. Never throws, never writes. It takes no person: the caller (the answer service) has already checked the asker's role on this project. */
  answerBriefing(input: { project: string; question: string; repos: readonly string[] }): Promise<string | undefined>;
  onEvents(operation: { workspaceId: string; id: string }, events: ReadonlyArray<{ type: string; payload: unknown }>): Promise<void>;
  usedInPullRequest(task: Pick<TaskRecord, "taskId" | "project" | "startingRevision">, repositoryId: string): Promise<LessonsUsedSection | undefined>;
  /** The numbered list written into a pull request's description (a comment's number refers to it). */
  listKey(taskId: string, repositoryId: string): { pk: string; sk: string };
  /** The milestone handler: a merged or closed task of this company is queued for reflection (nothing while off, or where the project's mode does not reflect). */
  milestone: CodeMilestoneHandler;
  /** One message of the reflection queue, already routed to this company by its company id. */
  reflectOne(body: string, visibility?: ReflectWorkerDeps["visibility"], deadlineMs?: number): Promise<ReflectOutcome>;
  /** The daily upkeep of these projects. */
  nightly(projects: readonly string[]): Promise<void>;
  /**
   * A pull request of the task was reverted: the task is reflected on again, as a reverted one. With `revert` (the reverting commit and the files it touched, undefined when they could not be read whole) the lessons the task loaded
   * are put UNDER QUESTION where a touched file is in the lesson's own code area (`revert-question.ts`): evidence only, no lesson is changed or scored.
   */
  noteReverted(taskId: string, revert?: RevertedChange): Promise<void>;
  /**
   * A person pushed to a pull request of the task (the tracking pass saw a head that is not one of Rovara's own): the person's commits are proved and read, and ONE human-edit job is queued for the head (L4-LM1c).
   * Nothing is read or queued while lessons are off for the company, where the project's mode does not reflect, for another company's task, or when the host did not give a person's edit worth reading. Absent without `humanEdit`.
   */
  noteHumanEdit: HumanEditSink;
  /**
   * Learn on send-back: a person just sent this task back with their words. One message of ids (`sent_back`, its round) is queued, so the correction is reflected on while the task is still open. Nothing is queued
   * while lessons are off for the company, where the project's mode does not reflect, for another company's task, a closed task, a send-back with no words of the person's (for a findings answer: no per-finding notes), or past
   * `SEND_BACK_REFLECTIONS_MAX` rounds (those are learned at the task's end). Never throws.
   */
  noteSentBack(taskId: string): Promise<void>;
  /** The task, when it is this company's. */
  ownTask(taskId: string): Promise<TaskRecord | undefined>;
}

/** The replay check's name for the live load's plan reading (#1051): the same function as `taskPlanFacts` (#1029), one implementation. */
export const taskPlanLoadFacts = taskPlanFacts;

export function createLessonsHost(input: LessonsHostInput): LessonsHost {
  const { flow, runtime, companyId, now, log, enabled } = input;
  const readText = textReaderOf(input.blobs);
  const ttl = (seconds: number): Record<string, number> => (flow.store.ttlAttribute === undefined ? {} : { [flow.store.ttlAttribute]: Math.floor(now() / 1000) + seconds });

  async function ownTask(taskId: string): Promise<TaskRecord | undefined> {
    const task = await readTask(flow, taskId);
    return task === undefined || task.companyId !== companyId ? undefined : task;
  }

  // ---- loading

  /** What the loader is told about a task besides its title: a summary of its latest plan and the files the plan names. */
  const planFactsOf = (task: TaskRecord): Promise<{ summary: string; files: string[] } | undefined> => taskPlanFacts(readText, task);

  /** An answer or "undefined" when the time passes: the extras never hold up the lessons. */
  const within = async <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work.catch(() => undefined), new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, ms); timer.unref?.(); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };

  async function learnedLessonsFor(request: Parameters<LessonsHost["learnedFor"]>[0]): Promise<{ learnedContext?: LearnedContext; knowledgeContext?: KnowledgeContext }> {
    const stage = request.workflowMode === undefined || !Object.hasOwn(STAGES, request.workflowMode) ? undefined : STAGES[request.workflowMode];
    if (stage === undefined || !enabled() || !request.features.includes(LEARNED_CONTEXT_FEATURE)) return {};
    // The knowledge briefing rides only to a worker that lists its feature; an older worker is sent the lessons alone.
    const briefing = request.features.includes(KNOWLEDGE_CONTEXT_FEATURE);
    // The plan check's lessons and the fix round's picking by the correction are part of the briefing: an older worker is sent exactly what it always was.
    if (stage === "PLAN_CRITIQUE" && !briefing) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pointer = fromDocument<TaskPointerRecord>(await flow.store.get((await workspaceKeys(flow, request.workspaceId)).taskPointerKey()));
      const task = pointer === undefined ? undefined : await ownTask(pointer.taskId);
      if (task === undefined || task.workflow === undefined) return {};
      const round = task.workflow.revision;
      // Set when the deadline passes: the dispatch went on without lessons, so nothing is recorded as loaded or used afterwards.
      let abandoned = false;
      const run = (async () => {
        const plan = await planFactsOf(task).catch(() => undefined);
        const project = await flow.projects.revision(task.project, task.startingRevision);
        const repos = project === undefined ? [] : codeRepositoriesOf(project.definition).map((repository) => repository.name);
        const requestText = (task as { requestText?: string }).requestText ?? "";
        // A fix round picks again by the correction: its words and the files it names come first, then the task's own (ranking only; none of it is stored or shown).
        const fixText = request.fix === undefined || !briefing ? "" : request.fix.text.slice(0, FIX_TEXT_CHARS);
        const intent = [...(fixText.trim() === "" ? [] : [fixText]), task.title, requestText.slice(0, INTENT_REQUEST_CHARS)].filter((part) => part.trim() !== "").join("\n");
        const files = [...new Set([...pathsNamedIn(fixText), ...(plan?.files ?? [])])].slice(0, 50);
        const loadRequest = {
          workspaceId: companyId, project: task.project, taskId: task.taskId, stage, round, intent, ...(plan === undefined || plan.summary === "" ? {} : { planSummary: plan.summary }),
          repos, files, languages: [] as string[], taskAudience: { kind: "shared" as const }, wanted: () => !abandoned,
        };
        // The look-up's lessons, the measured facts and the skill names are asked AT THE SAME TIME as the lessons, each on a short clock of its own, so they never add to the lessons' wait: a slow one is left out and the lessons still go.
        const parts = KNOWLEDGE_STAGE_PARTS[stage];
        const extra = { companyId, project: task.project, stage, files, repos };
        const extras = briefing ? Promise.all([
          parts.pull ? within(loadPullForStage(runtime.load, { workspaceId: companyId, project: task.project, taskId: task.taskId, stage, intent, ...(plan === undefined || plan.summary === "" ? {} : { planSummary: plan.summary }), repos, files, languages: [] }), KNOWLEDGE_EXTRAS_MS) : Promise.resolve(undefined),
          parts.facts && input.knowledge?.facts !== undefined ? within(input.knowledge.facts(extra), KNOWLEDGE_EXTRAS_MS) : Promise.resolve(undefined),
          parts.skills && input.knowledge?.skills !== undefined ? within(input.knowledge.skills(extra), KNOWLEDGE_EXTRAS_MS) : Promise.resolve(undefined),
        ]) : undefined;
        const loaded = briefing ? await lessonsAndPickedForDispatch(runtime.load, loadRequest, [LEARNED_CONTEXT_FEATURE]) : await learnedContextForDispatch(runtime.load, loadRequest, [LEARNED_CONTEXT_FEATURE]);
        if (abandoned) return {};
        let knowledgeContext: KnowledgeContext | undefined;
        if (extras !== undefined) {
          const [pull, facts, skills] = await extras;
          if (abandoned) return {};
          knowledgeContext = buildKnowledgeContext({ stage, pushed: (loaded as { picked?: Lesson[] }).picked ?? [], pull: pull?.picked, pullLeftOut: pull?.leftOut, facts, skills });
        }
        if (loaded.learnedContext === undefined && knowledgeContext === undefined) return {};
        // What this dispatch loaded, so the worker's report is applied to this stage's manifest only; and, for the lessons page, which tasks used which lessons.
        if (loaded.learnedContext !== undefined) {
          await flow.store.put({ item: lessonLoadRefItem({ companyId, operationId: request.operationId, taskId: task.taskId, project: task.project, stage, round, now: now(), ttlAttribute: flow.store.ttlAttribute }) });
          for (const lesson of loaded.learnedContext.lessons) {
            if (abandoned) return {};
            await flow.store.put({ item: lessonUseItem({ companyId, project: task.project, lessonId: lesson.id, taskId: task.taskId, title: task.title, now: now(), ttlAttribute: flow.store.ttlAttribute }) }).catch(() => undefined);
          }
        }
        // The ids this delivery gave (never text), so the worker's use report can only speak about this operation's own delivery.
        if (knowledgeContext !== undefined && !abandoned) {
          const record = deliveryRecordOf({ taskId: task.taskId, project: task.project, learnedLessonIds: (loaded.learnedContext?.lessons ?? []).map((lesson) => lesson.id), knowledge: knowledgeContext });
          await flow.store.put({ item: knowledgeGivenItem({ companyId, operationId: request.operationId, record, now, ttlAttribute: flow.store.ttlAttribute }) }).catch(() => undefined);
        }
        return { ...(loaded.learnedContext === undefined ? {} : { learnedContext: loaded.learnedContext }), ...(knowledgeContext === undefined ? {} : { knowledgeContext }) };
      })();
      const result = await Promise.race([run, new Promise<{ learnedContext?: LearnedContext; knowledgeContext?: KnowledgeContext }>((resolve) => { timer = setTimeout(() => { abandoned = true; resolve({}); }, LESSON_LOAD_DEADLINE_MS); timer.unref?.(); })]);
      return { ...(result.learnedContext === undefined ? {} : { learnedContext: result.learnedContext }), ...(result.knowledgeContext === undefined ? {} : { knowledgeContext: result.knowledgeContext }) };
    } catch (error) {
      log("load_failed", { error: error instanceof Error ? error.name : "unknown" });
      return {};
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The project's live Rovara skills for a plan or build step (L4-AK3), for a worker that lists the feature: read with `get` only from the step's OWN task's company and project, behind the same switches as lessons (the install's
   * lessons switch and the project's learning mode). A slow or failed read is none: a step never waits on a skill. Skills left out for their limits are counted in the log, never named.
   */
  async function skillsFor(request: Parameters<LessonsHost["learnedFor"]>[0]): Promise<RovaraSkillFile[]> {
    if ((request.workflowMode !== "PLAN" && request.workflowMode !== "IMPLEMENT") || !enabled() || !request.features.includes(ROVARA_SKILLS_FEATURE)) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pointer = fromDocument<TaskPointerRecord>(await flow.store.get((await workspaceKeys(flow, request.workspaceId)).taskPointerKey()));
      const task = pointer === undefined ? undefined : await ownTask(pointer.taskId);
      if (task === undefined) return [];
      const run = (async () => {
        const resolved = await resolveLearning(runtime.settings, companyId, task.project);
        if (!modeAllows(resolved.chosenMode, "load")) return [];
        const live = await liveSkillsForStep(flow.store, { workspaceId: companyId, project: task.project });
        if (live.left > 0) log("skills_left_out", { left: live.left });
        return live.skills;
      })();
      return await Promise.race([run, new Promise<RovaraSkillFile[]>((resolve) => { timer = setTimeout(() => resolve([]), LESSON_LOAD_DEADLINE_MS); timer.unref?.(); })]);
    } catch { return []; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async function learnedFor(request: Parameters<LessonsHost["learnedFor"]>[0]): Promise<{ learnedContext?: LearnedContext; knowledgeContext?: KnowledgeContext; rovaraSkills?: RovaraSkillFile[] }> {
    const [lessons, skills] = await Promise.all([learnedLessonsFor(request), skillsFor(request)]);
    return { ...lessons, ...(skills.length === 0 ? {} : { rovaraSkills: skills }) };
  }

  /**
   * The suggestions one of Rovara's own agents made in a step (L4-AK3): taken from the worker's progress events and handed to `proposeKnowledge` for the step's OWN task and project (read from the workspace's task
   * pointer, never from the event). The company switch "Knowledge stays in Rovara" is about tools outside Rovara and does not stop this. Each is checked, limited (3 a task) and audited by `proposeKnowledge`; a
   * fault loses only a suggestion.
   */
  async function onAgentProposals(operation: { workspaceId: string; id: string }, proposals: readonly unknown[]): Promise<void> {
    try {
      const pointer = fromDocument<TaskPointerRecord>(await flow.store.get((await workspaceKeys(flow, operation.workspaceId)).taskPointerKey()));
      const task = pointer === undefined ? undefined : await ownTask(pointer.taskId);

      if (task === undefined) return;
      const limits = proposeLimits(flow.store, now);
      for (const proposal of proposals.slice(0, 10)) {
        await proposeKnowledge({ process: runtime.process, limits }, { companyId, project: task.project, proposer: { kind: "agent", taskId: task.taskId }, requesterId: task.developerId, proposal });
      }
    } catch { /* information only: a lost suggestion costs nothing */ }
  }

  async function onEvents(operation: { workspaceId: string; id: string }, events: ReadonlyArray<{ type: string; payload: unknown }>): Promise<void> {
    if (!enabled()) return;
    const proposed = events.slice(0, 500).flatMap((event) => (event.type === "progress" ? (knowledgeProposalsOfProgress(event.payload) ?? []) : []));
    
    if (proposed.length > 0) await onAgentProposals(operation, proposed);
    try {
      const slice = events.slice(0, 500);
      // Lead 4 L4-AK2: the worker's use report (ids only) is checked against what this operation was delivered and kept as the operation's latest. Information only; it moves no counter yet (the 1/k credit is its own lane).
      const useReports = slice.flatMap((event) => (event.type === "progress" ? [knowledgeUseReportOfProgress(event.payload)] : [])).flatMap((report) => (report === undefined ? [] : [report]));
      const lastUse = useReports.at(-1);
      if (lastUse !== undefined) await recordKnowledgeUseReport({ store: flow.store, companyId, operationId: operation.id, report: lastUse, now, ttlSeconds: USE_RECORD_KEEP_SECONDS, ttl }).catch(() => undefined);
      const reports = slice.flatMap((event) => (event.type === "progress" ? [learnedLoadReportOfProgress(event.payload)] : [])).flatMap((report) => (report === undefined ? [] : [report]));
      if (reports.length === 0) return;
      const ref = await flow.store.get({ pk: companyScoped(companyId, "LESSON_LOAD"), sk: operation.id });
      if (ref === undefined || typeof ref["taskId"] !== "string" || typeof ref["project"] !== "string" || typeof ref["stage"] !== "string" || typeof ref["round"] !== "number") return;
      const resolved = await resolveLearning(runtime.settings, companyId, ref["project"]);
      if (!modeAllows(resolved.mode, "load")) return;
      for (const report of reports) {
        if (report.stage !== ref["stage"]) continue;
        await applyLoadReport(runtime.counters, { workspaceId: companyId, project: ref["project"], taskId: ref["taskId"], stage: report.stage, round: ref["round"], report });
      }
    } catch { /* information only: a lost report leaves a lesson "not checked"; it never fails the worker's events */ }
  }

  // ---- the pull request

  const usedReader = lessonsUsedReaderOver({ store: runtime.store, settings: runtime.settings, access: runtime.access, commands: true, names: runtime.routes.names, visibility: async (_orgId, project) => input.visibility(project) });
  async function usedSummary(task: Pick<TaskRecord, "taskId" | "project" | "startingRevision">, repositoryId: string): Promise<LessonsUsedSummary | undefined> {
    return usedReader({ orgId: companyId, project: task.project, taskId: task.taskId, pageUrl: undefined, repo: repositoryId, startingRevision: task.startingRevision });
  }
  // The numbers a pull request shows are the position in the list written into its description. That list is kept as it was written, so a comment's number means what the person read, even after
  // the lessons held, or a later round's list, have moved on.
  const listKey = (taskId: string, repositoryId: string) => ({ pk: companyScoped(companyId, `LESSON_LIST#${taskId}`), sk: repositoryId });
  async function recordList(task: Pick<TaskRecord, "taskId" | "project">, repositoryId: string, ids: readonly string[]): Promise<void> {
    await flow.store.put({ item: { ...listKey(task.taskId, repositoryId), entityType: "LESSON_LIST", project: task.project, ids: [...ids], ...ttl(USE_RECORD_KEEP_SECONDS) } }).catch(() => undefined);
  }
  async function usedInPullRequest(task: Pick<TaskRecord, "taskId" | "project" | "startingRevision">, repositoryId: string): Promise<LessonsUsedSection | undefined> {
    // Switched off, the description says so; switched on with nothing used yet, it says that: the section is there either way and a reader knows why it is empty.
    if (!enabled()) { await recordList(task, repositoryId, []); return { count: 0, taskUrl: "", entries: [], none: true, reason: "off" }; }
    try {
      const summary = await usedSummary(task, repositoryId);
      await recordList(task, repositoryId, summary?.items.map((item) => item.id) ?? []);
      const section = lessonsUsedSection(summary);
      return section === undefined || section.count <= 0 ? { count: 0, taskUrl: "", entries: [], none: true, reason: "unused" } : section;
    } catch { return undefined; }
  }

  // ---- capture

  let queuePromise: ReturnType<typeof reflectQueueOf> | undefined;
  let reflectQueue: ReturnType<typeof queueReflectQueue> | undefined;
  const queueOf = (): ReturnType<typeof reflectQueueOf> => (queuePromise ??= reflectQueueOf(input.queues));
  const sender = async (): Promise<ReturnType<typeof queueReflectQueue>> => (reflectQueue ??= queueReflectQueue(await queueOf()));

  const claims = documentReflectClaims({ store: flow.store, keysOutcome: async () => "clear" });
  const learning: TaskLearningDeps = {
    source: input.sources.source, rows: input.sources.rows, settings: runtime.settings,
    reflect: { model: runtime.judgeModel, spend: runtime.spend, audit: runtime.audit, settings: runtime.settings, edition: runtime.edition, now, pause: runtime.pause, pausedKinds: (key) => pausedKindsFor(runtime.store, key) },
    process: runtime.process, counters: runtime.counters, log: (event, fields) => log(event, fields),
    // The "same mistake twice" measure's log (no text): only this company's tasks, in this company's partition.
    correctionLog: async (entry) => {
      if (entry.workspaceId !== companyId) return;
      await logTaskCorrections(flow.store, { companyId, project: entry.project, taskId: entry.taskId, corrections: entry.corrections, now: now() });
    },
  };
  // L4-LM1c: a person's edit to a Rovara pull request. The extractor makes its model call through the same reflection path as a task's end (the customer's own AI account, the company's learning spend), and the job's
  // `run` proves everything again from this company's own records and the code host.
  const humanEditWork = input.humanEdit === undefined ? undefined : (() => {
    const edit = input.humanEdit;
    const extractor = createHumanEditExtractor({
      source: learning.source, settings: runtime.settings, reflect: learning.reflect, process: learning.process,
      standing: (orgId, developerId, project) => (orgId === companyId ? edit.standing(orgId, developerId, project) : Promise.resolve("outsider" as const)),
      isErased: (orgId, developerId, project) => edit.isErased(orgId, developerId, project),
      log: (event, fields) => log(event, fields),
    });
    return createHumanEditRun({ companyId, ownTask, repos: edit.repos, personOf: edit.personOf, extractor, now, recordedHead: recordedHeadOf(flow) });
  })();
  const workerDeps = (visibility?: ReflectWorkerDeps["visibility"], deadlineMs = LESSONS_WORKER_DEADLINE_SECONDS * 1000): ReflectWorkerDeps => ({
    claims, now, deadlineMs: Math.min(deadlineMs, LESSONS_WORKER_DEADLINE_SECONDS * 1000), ...(visibility === undefined ? {} : { visibility }), log: (event, fields) => log(event, fields),
    // A message names its company: one of another company is never this company's to learn from (it is answered as having nothing to learn from, and not retried).
    learn: async (message) => (message.workspaceId !== companyId ? { status: "no_facts", retry: false } : await learnFromEndedTaskTyped(learning, message)),
    ...(humanEditWork === undefined ? {} : {
      humanEdit: async (job) => (job.repo.workspaceId !== companyId ? { status: "no_facts", retry: false } : await learnFromHumanEdit({ run: humanEditWork, settings: runtime.settings, store: runtime.store }, job)),
    }),
  });

  /** A person's push to a pull request of this company's task (L4-LM1c). Never throws except for a code host's "slow down" and a spent allowance, which the pass owns. */
  const produceHumanEdit = humanEditWork === undefined ? undefined : createHumanEditProducer({ companyId, store: flow.store, settings: runtime.settings, enabled, canPlaceAuthors: () => input.humanEdit?.canPlaceAuthors() === true, ownTask, queue: sender, now, log: (event, fields) => log(event, fields) });
  const noteHumanEdit: HumanEditSink = async (push) => { await produceHumanEdit?.(push); };

  /** One message of the reflection queue, for this company (the caller routed it here by its company). */
  async function reflectOne(body: string, visibility?: ReflectWorkerDeps["visibility"], deadlineMs?: number): Promise<ReflectOutcome> {
    return await runReflectMessage(workerDeps(visibility, deadlineMs), body).catch(() => ({ result: "failed" as const, retry: true }));
  }

  const onTaskEnd = learningTaskEndHandler(() => ({ queue: { send: async (message) => (await sender()).send(message) }, log: (event, fields) => log(event, fields) }));
  const endOf = (kind: string): TaskEndOutcome | undefined => (kind === "merged" ? "merged" : kind === "closed" ? "closed" : undefined);
  const milestone: CodeMilestoneHandler = {
    name: "lessons",
    async on(event) {
      // Behind the switch: with it off nothing is queued, so no later switching-on finds a backlog of old tasks to pay for.
      if (!enabled()) return;
      const outcome = endOf(event.kind);
      if (outcome === undefined) return;
      const task = await ownTask(event.taskId);
      if (task === undefined) return;
      const resolved = await resolveLearning(runtime.settings, companyId, task.project);
      if (!modeAllows(resolved.mode, "reflect")) return;
      // Phase 0 (measure only): a merged task is one row of the project's clean-merge count (`measure.ts`); the sink never throws and changes nothing below.
      if (outcome === "merged") await runtime.load.measure?.merged({ workspaceId: companyId, project: task.project, taskId: task.taskId, at: now() });
      await onTaskEnd({ orgId: companyId, taskId: event.taskId, outcome });
    },
  };

  // ---- upkeep

  async function nightly(projects: readonly string[]): Promise<void> {
    const { sweepExpired } = await import("./expiry.js");
    const { countLessonUses } = await import("./use-count.js");
    const { promoteStableTrials } = await import("./trial.js");
    for (const project of projects) {
      const key = { workspaceId: companyId, project };
      const resolved = await resolveLearning(runtime.settings, companyId, project);
      if (!modeAllows(resolved.chosenMode, "capture")) continue;
      // Fade by chances (phase 2): a lesson no task had a chance to use is renewed once and then a person is asked; one that had chances and never helped fades (`expiry.ts`). The chance count is the lesson's use rows in its window.
      const fade: FadePorts = {
        evidence: runtime.evidence, expiryDays: resolved.expiryDays,
        chances: async (scope, lessonId, since) => { const counted = await countLessonUses(flow.store, { companyId, project: scope.project, lessonIds: [lessonId], now: now(), since }); return counted.counts.get(lessonId)?.tasks; },
      };
      await sweepExpired({ ...runtime.counters, vectors: runtime.vectors }, runtime.store, key, { fade }).catch(() => undefined);
      await promoteStableTrials({ ...runtime.counters, store: runtime.store }, key).catch(() => undefined);
      // The nightly area checks (no model): a lesson whose code area is gone goes under question; one whose area was rewritten asks a person (`area-check.ts`). A fault is information only.
      if (input.areaChecks !== undefined) await runAreaChecks({ lessons: runtime.store, docs: flow.store, companyId, now, ports: input.areaChecks, log: (event, fields) => log(event, fields) }, key).catch(() => undefined);
    }
  }

  async function noteReverted(taskId: string, revert?: RevertedChange): Promise<void> {
    if (!enabled()) return;
    const task = await ownTask(taskId).catch(() => undefined);
    if (task === undefined) return;
    // Phase 0 (measure only): the revert is one row of the project's clean-merge count (`measure.ts`), under the same rule as the merged row (the project's mode reflects); the sink never throws.
    // Batch 17: the measure row is a count (ids never shown) and is not a learning source, so it is kept like the merged row; the "After merge" stop below gates everything learned from the revert.
    let outcomeStopped: boolean;
    try { outcomeStopped = (await pausedKindsFor(runtime.store, { workspaceId: companyId, project: task.project })).has("outcome"); } catch { outcomeStopped = true; }
    try {
      if (modeAllows((await resolveLearning(runtime.settings, companyId, task.project)).mode, "reflect")) {
        await runtime.load.measure?.reverted({ workspaceId: companyId, project: task.project, taskId: task.taskId, at: now() });
        // The lessons the task loaded go "under question" only where the revert's files are in the lesson's own code area: a separate evidence row, no lesson is changed or scored (`revert-question.ts`).
        // Lead 4 L4-LP3Wc: not while "After merge" is stopped (nothing of the revert is kept).
        if (revert !== undefined && !outcomeStopped) await markLessonsUnderQuestion({ lessons: runtime.store, docs: flow.store, companyId, now }, { project: task.project, taskId: task.taskId, via: revert.via, files: revert.files });
      }
    } catch { /* information only */ }
    // Lead 4 L4-LP3Wc: "After merge" paused: nothing is queued about the revert (a stop: it is not read, and nothing of it is kept).
    if (outcomeStopped) return;
    try { await (await sender()).send({ orgId: companyId, taskId, outcome: "reverted", requestId: randomUUID() }); } catch { log("revert_not_queued"); }
  }

  async function noteSentBack(taskId: string): Promise<void> {
    try {
      // Behind the switch: with it off nothing is read or queued. Inside the try: a switch that cannot be read is one log line, never a fault in the send-back.
      if (!enabled()) return;
      // The task is read now and must be this company's: the message's company is the task's own, never a caller's claim.
      const task = await ownTask(taskId);
      if (task === undefined || task.workflow === undefined || task.closedAt !== undefined) return;
      // Lead 4 L4-LP3Wc: "Decisions in tasks" paused: the send-back is not read and no reflection is queued for it (a stop, not a hold).
      if ((await pausedKindsFor(runtime.store, { workspaceId: companyId, project: task.project })).has("send_back")) return;
      const sentBack = task.workflow.decisions.filter(isHumanSendBack);
      const round = sentBack.length;
      const latest = sentBack.at(-1);
      if (latest === undefined || round > SEND_BACK_REFLECTIONS_MAX) return;
      if (latest.source === "FINDINGS") {
        // A findings answer's reason is code's own summary ("N accepted, M to fix", contracts `resolveWorkflowReviewFindings`), never the person's words. Their words are the per-finding notes kept beside the workflow
        // (owner note): with none, the round counts but there is nothing to learn from.
        if ((await readOwnerFindingNotes(flow.store, task.taskId, latest.requestId)).length === 0) return;
      } else {
        // Only a person's own words are a correction: no reason, or code's fixed sentence, queues nothing.
        const words = latest.reason.trim();
        if (words === "" || words === NO_REASON_TEXT) return;
      }
      const resolved = await resolveLearning(runtime.settings, companyId, task.project);
      if (!modeAllows(resolved.mode, "reflect")) return;
      await (await sender()).send({ orgId: companyId, taskId: task.taskId, outcome: "sent_back", round, requestId: sendBackRequestId(task.taskId, round) });
    } catch { log("send_back_not_queued"); }
  }

  async function answerBriefing(request: Parameters<LessonsHost["answerBriefing"]>[0]): Promise<string | undefined> {
    if (!enabled()) return undefined;
    try {
      return await loadAnswerBriefing({ ...runtime.load, ...(input.knowledge?.facts === undefined ? {} : { facts: input.knowledge.facts }) }, { workspaceId: companyId, project: request.project, question: request.question, repos: request.repos });
    } catch { return undefined; }
  }

  return { learnedFor, answerBriefing, onEvents, usedInPullRequest, listKey, milestone, reflectOne, nightly, noteReverted, noteHumanEdit, noteSentBack, ownTask };
}

export type ReflectOutcome = Awaited<ReturnType<typeof runReflectMessage>> | { result: "failed"; retry: true };

/** The company a reflection queue message is for (both kinds name it), or undefined when the body is not one. */
export function reflectMessageCompany(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const orgId = (body as { orgId?: unknown }).orgId;
  return typeof orgId === "string" ? orgId : undefined;
}

/**
 * One pass over the install's reflection queue. The queue is one per install; each message names its company and is handed to THAT company's host (`hostFor`), so a company only ever learns from
 * its own tasks. A message for a company with no host (lessons off for it, or no such company) is removed: with lessons off nothing is learned, and nothing is kept to be paid for later. A host that cannot
 * be built now leaves the message for a retry. A message that is not one is handed to no company and removed (the worker's own parser would refuse it too).
 */
/** The least time left for which a pass still takes a message: a reflection is one model call, and a message started with less time would only time out and come back. */
export const REFLECT_MIN_TIME_MS = 30_000;

export async function pumpReflectQueue(input: {
  queues: QueueService; hostFor: (companyId: string) => Promise<Pick<LessonsHost, "reflectOne"> | undefined>; perPass?: number; now: () => number; log: (event: string, fields?: Record<string, unknown>) => void;
  /** When the pass must be done (ms since the epoch). Messages are taken one at a time while at least `REFLECT_MIN_TIME_MS` is left, and each reflection's own deadline is the time left. Absent: no limit of its own. */
  deadlineAt?: number;
}): Promise<{ received: number; reflected: number; dropped: number; retried: number }> {
  const queue = await reflectQueueOf(input.queues);
  const visibility = queueReflectVisibility(queue);
  let received = 0;
  let reflected = 0;
  let dropped = 0;
  let retried = 0;
  const timeLeft = (): number => (input.deadlineAt === undefined ? Number.POSITIVE_INFINITY : input.deadlineAt - input.now());
  for (let taken = 0; taken < (input.perPass ?? REFLECT_PER_PASS) && timeLeft() >= REFLECT_MIN_TIME_MS; taken += 1) {
    const [message] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 10 * 60 });
    if (message === undefined) break;
    received += 1;
    const companyId = reflectMessageCompany(message.body);
    let host: Pick<LessonsHost, "reflectOne"> | undefined;
    try {
      host = companyId === undefined ? undefined : await input.hostFor(companyId);
    } catch (error) {
      input.log("reflect_host_unavailable", { error: error instanceof Error ? error.name : "unknown" });
      retried += 1;
      await queue.changeVisibility(message.receiptHandle, retryDelayFor(message.receiveCount, undefined, input.now())).catch(() => undefined);
      continue;
    }
    if (host === undefined) {
      dropped += 1;
      input.log("reflect_dropped", { reason: companyId === undefined ? "not_a_message" : "lessons_off" });
      await queue.ack(message.receiptHandle).catch(() => undefined);
      continue;
    }
    const left = timeLeft();
    const outcome = await host.reflectOne(JSON.stringify(message.body), visibility, Number.isFinite(left) ? Math.max(1_000, left - 5_000) : undefined);
    if (outcome.retry) {
      retried += 1;
      await queue.changeVisibility(message.receiptHandle, retryDelayFor(message.receiveCount, "retryAt" in outcome ? outcome.retryAt : undefined, input.now())).catch(() => undefined);
    } else {
      reflected += 1;
      await queue.ack(message.receiptHandle).catch(() => undefined);
    }
  }
  return { received, reflected, dropped, retried };
}
