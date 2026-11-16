// The parts of joining the lessons library to the task flow that every host does the same way, whether one person on a laptop (`local/app/lessons.ts`) or a company on a deployed install
// (`core-host/lessons.ts`). Each is built for ONE company: a task, a load record or a queue message of another company is not this company's, and is ignored.
//   loading     at the dispatch of a step: the lessons that fit the task, the load record (so the worker's report is applied to this stage only) and which tasks used which lessons;
//   reports     the worker's load report, applied to the manifest its dispatch recorded;
//   the PR      the "Lessons used" section of a task's pull request and the numbered list a comment refers to;
//   capture     a merged or closed task puts one message of ids on the `lessons-reflect` queue; a pass reads it, takes a lease and reflects. So does a person's send-back of a task that is still open
//               (`noteSentBack`, learn on send-back): its correction can help the next task before this one ends;
//   upkeep      once a day per project: expired lessons swept, stable trials promoted, the repository lessons file's erasure sweep and weekly pass.
// Nothing here makes a model call by itself: the reflection worker does, through the runtime's model, which the library gates on the switch.
import { randomUUID } from "node:crypto";
import {
  LEARNED_CONTEXT_FEATURE, LESSONS_WORKER_DEADLINE_SECONDS, codeRepositoriesOf, companyScoped, learnedLoadReportOfProgress,
  type LearnedContext, type ObjectStorage, type OrgId, type QueueService,
} from "@agentx/contracts";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { taskPointerKey } from "../core/task-flow/keys.js";
import { readTask } from "../core/task-flow/reads.js";
import { fromDocument, type TaskPointerRecord, type TaskRecord } from "../core/task-flow/records.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { loadWorkflowDocument } from "../developer/plan-document-reader.js";
import type { LessonsUsedSection } from "../core/proof/pull-request-body.js";
import type { CodeMilestoneHandler } from "../core/milestones/milestones.js";
import { applyLoadReport } from "./counters.js";
import { logTaskCorrections } from "./correction-log.js";
import { learnedContextForDispatch } from "./load.js";
import { modeAllows, resolveLearning } from "./policy.js";
import type { LessonsRuntime } from "./runtime.js";
import { documentReflectClaims } from "./reflect-claims.js";
import { SEND_BACK_REFLECTIONS_MAX, reflectQueueOf, queueReflectQueue, queueReflectVisibility, sendBackRequestId } from "./reflect-queue.js";
import { isHumanSendBack } from "./human-send-backs.js";
import { NO_REASON_TEXT } from "./task-subject.js";
import { retryDelayFor, runReflectMessage, type ReflectWorkerDeps } from "./reflect-worker.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskEndOutcome, type TaskLearningDeps } from "./task-end.js";
import { lessonsUsedReaderOver, lessonsUsedSection, type LessonsUsedSummary, type RepositoryVisibility } from "./used-in-pr.js";
import { lessonsRepoFilePublishJob, lessonsRepoFileSweepJob } from "./repo-file-job.js";
import { planLoadFacts } from "./plan-facts.js";
import { LESSON_USE_KEEP_SECONDS } from "./use-count.js";
import type { OutcomeRowReader } from "./task-outcome-rows.js";

/** The longest a step's dispatch waits for the loader: a slow load sends nothing, and the step runs as it would without lessons. */
export const LESSON_LOAD_DEADLINE_MS = 2_500;
/** The messages one pass takes off the reflection queue. */
export const REFLECT_PER_PASS = 2;
const LOAD_RECORD_KEEP_SECONDS = 30 * 86_400;
/** The use rows ("used in N tasks", `use-count.ts`) are kept as long as that module counts them. */
const USE_RECORD_KEEP_SECONDS = LESSON_USE_KEEP_SECONDS;
const INTENT_REQUEST_CHARS = 600;

/** The workflow modes that carry lessons, and the lesson stage each is. Every other mode (the checks, a publication) carries none. */
const STAGES: Readonly<Record<string, "UNDERSTAND" | "PLAN" | "IMPLEMENT" | "REVIEW">> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", REVIEW: "REVIEW" };

export interface LessonsHostInput {
  flow: TaskFlowDeps;
  runtime: LessonsRuntime;
  companyId: OrgId;
  blobs: ObjectStorage;
  queues: QueueService;
  /** Whether lessons are on for this company now (read at every ask). */
  enabled: () => boolean;
  /** What the reflector reads of an ended task (its record, the people's words, its outcome rows). */
  sources: { source: TaskLearningDeps["source"]; rows: OutcomeRowReader };
  /** Whether the repositories a pull request of the project is in are public, private or unknown (for which lessons a description may name). */
  visibility: (project: string) => Promise<RepositoryVisibility>;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export interface LessonsHost {
  learnedFor(input: { workspaceId: string; operationId: string; workflowMode: string | undefined; features: readonly string[] }): Promise<{ learnedContext?: LearnedContext }>;
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
  /** A pull request of the task was reverted: the task is reflected on again, as a reverted one. */
  noteReverted(taskId: string): Promise<void>;
  /**
   * Learn on send-back: a person just sent this task back with their words. One message of ids (`sent_back`, its round) is queued, so the correction is reflected on while the task is still open. Nothing is queued
   * while lessons are off for the company, where the project's mode does not reflect, for another company's task, a closed task, a send-back with no words of the person's, or past
   * `SEND_BACK_REFLECTIONS_MAX` rounds (those are learned at the task's end). Never throws.
   */
  noteSentBack(taskId: string): Promise<void>;
  /** The task, when it is this company's. */
  ownTask(taskId: string): Promise<TaskRecord | undefined>;
}

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
  async function planFactsOf(task: TaskRecord): Promise<{ summary: string; files: string[] } | undefined> {
    const artifact = task.workflow?.artifacts.filter((entry) => entry.type === "plan").sort((a, b) => a.version - b.version).at(-1);
    if (artifact === undefined) return undefined;
    const loaded = await loadWorkflowDocument(readText, artifact, {});
    if (loaded === undefined) return undefined;
    if (loaded.format === "structured") return planLoadFacts(loaded.plan);
    // A Markdown plan: its first words are the summary, and the files it names in words are the files.
    return planLoadFacts({ title: loaded.markdown.split("\n", 1)[0] ?? "", claims: [{ text: loaded.markdown.slice(0, 20_000) }] } as unknown as Parameters<typeof planLoadFacts>[0]);
  }

  async function learnedFor(request: Parameters<LessonsHost["learnedFor"]>[0]): Promise<{ learnedContext?: LearnedContext }> {
    const stage = request.workflowMode === undefined || !Object.hasOwn(STAGES, request.workflowMode) ? undefined : STAGES[request.workflowMode];
    if (stage === undefined || !enabled() || !request.features.includes(LEARNED_CONTEXT_FEATURE)) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pointer = fromDocument<TaskPointerRecord>(await flow.store.get(taskPointerKey(request.workspaceId)));
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
        const intent = [task.title, requestText.slice(0, INTENT_REQUEST_CHARS)].filter((part) => part.trim() !== "").join("\n");
        const loaded = await learnedContextForDispatch(runtime.load, {
          workspaceId: companyId, project: task.project, taskId: task.taskId, stage, round, intent, ...(plan === undefined || plan.summary === "" ? {} : { planSummary: plan.summary }),
          repos, files: plan?.files ?? [], languages: [], taskAudience: { kind: "shared" }, wanted: () => !abandoned,
        }, [LEARNED_CONTEXT_FEATURE]);
        if (loaded.learnedContext === undefined || abandoned) return {};
        // What this dispatch loaded, so the worker's report is applied to this stage's manifest only; and, for the lessons page, which tasks used which lessons.
        await flow.store.put({ item: { pk: companyScoped(companyId, "LESSON_LOAD"), sk: request.operationId, entityType: "LESSON_LOAD_REF", taskId: task.taskId, project: task.project, stage, round, ...ttl(LOAD_RECORD_KEEP_SECONDS) } });
        for (const lesson of loaded.learnedContext.lessons) {
          if (abandoned) return {};
          await flow.store.put({ item: { pk: companyScoped(companyId, `LESSON_USE#${task.project}#${lesson.id}`), sk: task.taskId, entityType: "LESSON_USE", taskId: task.taskId, title: task.title.slice(0, 200), at: now(), ...ttl(USE_RECORD_KEEP_SECONDS) } }).catch(() => undefined);
        }
        return loaded;
      })();
      const result = await Promise.race([run, new Promise<{ learnedContext?: LearnedContext }>((resolve) => { timer = setTimeout(() => { abandoned = true; resolve({}); }, LESSON_LOAD_DEADLINE_MS); timer.unref?.(); })]);
      return result.learnedContext === undefined ? {} : { learnedContext: result.learnedContext };
    } catch (error) {
      log("load_failed", { error: error instanceof Error ? error.name : "unknown" });
      return {};
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function onEvents(operation: { workspaceId: string; id: string }, events: ReadonlyArray<{ type: string; payload: unknown }>): Promise<void> {
    if (!enabled()) return;
    try {
      const reports = events.slice(0, 500).flatMap((event) => (event.type === "progress" ? [learnedLoadReportOfProgress(event.payload)] : [])).flatMap((report) => (report === undefined ? [] : [report]));
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
    reflect: { model: runtime.judgeModel, spend: runtime.spend, audit: runtime.audit, settings: runtime.settings, edition: runtime.edition, now, pause: runtime.pause },
    process: runtime.process, counters: runtime.counters, log: (event, fields) => log(event, fields),
    // The "same mistake twice" measure's log (no text): only this company's tasks, in this company's partition.
    correctionLog: async (entry) => {
      if (entry.workspaceId !== companyId) return;
      await logTaskCorrections(flow.store, { companyId, project: entry.project, taskId: entry.taskId, corrections: entry.corrections, now: now() });
    },
  };
  const workerDeps = (visibility?: ReflectWorkerDeps["visibility"], deadlineMs = LESSONS_WORKER_DEADLINE_SECONDS * 1000): ReflectWorkerDeps => ({
    claims, now, deadlineMs: Math.min(deadlineMs, LESSONS_WORKER_DEADLINE_SECONDS * 1000), ...(visibility === undefined ? {} : { visibility }), log: (event, fields) => log(event, fields),
    // A message names its company: one of another company is never this company's to learn from (it is answered as having nothing to learn from, and not retried).
    learn: async (message) => (message.workspaceId !== companyId ? { status: "no_facts", retry: false } : await learnFromEndedTaskTyped(learning, message)),
  });

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
      await onTaskEnd({ orgId: companyId, taskId: event.taskId, outcome });
    },
  };

  // ---- upkeep

  async function nightly(projects: readonly string[]): Promise<void> {
    const { sweepExpired } = await import("./expiry.js");
    const { promoteStableTrials } = await import("./trial.js");
    for (const project of projects) {
      const key = { workspaceId: companyId, project };
      const resolved = await resolveLearning(runtime.settings, companyId, project);
      if (!modeAllows(resolved.chosenMode, "capture")) continue;
      await sweepExpired({ ...runtime.counters, vectors: runtime.vectors }, runtime.store, key, {}).catch(() => undefined);
      await promoteStableTrials({ ...runtime.counters, store: runtime.store }, key).catch(() => undefined);
    }
    // The erasure sweep comes first and has its own budget; then the weekly lessons file pass (each repository is off until a person switches it on).
    const repoFile = runtime.repoFile;
    if (repoFile === undefined) return;
    const day = Math.floor(now() / 86_400_000);
    await lessonsRepoFileSweepJob(repoFile, companyId, projects, 60_000, day).catch(() => undefined);
    await lessonsRepoFilePublishJob(repoFile, companyId, projects, 120_000, day).catch(() => undefined);
  }

  async function noteReverted(taskId: string): Promise<void> {
    if (!enabled()) return;
    if (await ownTask(taskId).catch(() => undefined) === undefined) return;
    try { await (await sender()).send({ orgId: companyId, taskId, outcome: "reverted", requestId: randomUUID() }); } catch { log("revert_not_queued"); }
  }

  async function noteSentBack(taskId: string): Promise<void> {
    try {
      // Behind the switch: with it off nothing is read or queued. Inside the try: a switch that cannot be read is one log line, never a fault in the send-back.
      if (!enabled()) return;
      // The task is read now and must be this company's: the message's company is the task's own, never a caller's claim.
      const task = await ownTask(taskId);
      if (task === undefined || task.workflow === undefined || task.closedAt !== undefined) return;
      const sentBack = task.workflow.decisions.filter(isHumanSendBack);
      const round = sentBack.length;
      const latest = sentBack.at(-1);
      if (latest === undefined || round > SEND_BACK_REFLECTIONS_MAX) return;
      // Only a person's own words are a correction: no reason, or code's fixed sentence, queues nothing.
      const words = latest.reason.trim();
      if (words === "" || words === NO_REASON_TEXT) return;
      const resolved = await resolveLearning(runtime.settings, companyId, task.project);
      if (!modeAllows(resolved.mode, "reflect")) return;
      await (await sender()).send({ orgId: companyId, taskId: task.taskId, outcome: "sent_back", round, requestId: sendBackRequestId(task.taskId, round) });
    } catch { log("send_back_not_queued"); }
  }

  return { learnedFor, onEvents, usedInPullRequest, listKey, milestone, reflectOne, nightly, noteReverted, noteSentBack, ownTask };
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
