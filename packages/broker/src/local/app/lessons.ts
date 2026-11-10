// Lessons on a laptop. Rovara learns from what a finished task shows (the owner's send-backs, the reviewers' comments on its pull requests, how it ended), keeps what it learned as short typed advice with citations, and
// lets the owner decide what is used. This file joins the lessons library (`lessons/`) to the pieces `rovara up` has already built (the task flow, the code host adapters, the model the steps use, the registry's
// `audit-sink`, `admission`, `metering`, `approvers`, `queue`, `storage` and `learning` points). The library knows none of them: it is given ports (`lessons/runtime.ts`).
//
// switch learning and loading are on unless `ROVARA_LESSONS=0` (and the project mode is Suggest unless it chose another: every lesson waits for the owner). While it is off nothing is reflected, loaded or sent to an agent and no model call is made (the pages still show what exists);
// capture a task that is merged or closed (the milestone hook) puts one message of ids on the `lessons-reflect` queue; a pass of the app's timer reads it, takes a lease on it, reads the task's record
// (`lessons-sources.ts`), asks the model for at most three lessons, curates them against the lessons held and settles each one (on trial, waiting for the owner, or dropped);
// approval a lesson that waits is approved on the owner's lessons page. The page's form carries a proof signed over that lesson's own text and version; the `approvers` point verifies it, and only then does the
// library's approval run. A comment cannot approve a lesson: it can only mark one "wrong" or "right" for the task it was used in, as its own author, or ask for one to be retired (the owner confirms on the page);
// loading at the dispatch of a step (understand, plan, code, review) the library picks the lessons that fit the task, writes what it loaded as the task's load record, and hands the worker a `learnedContext`
// (ids and versions are checked again when the step is delivered, so a lesson retired meanwhile is not sent);
// repository the lessons that were learned only from a repository's own review comments may be proposed to that repository as `.rovara/lessons.md`, in a pull request, by the weekly pass (off per repository).
import { createHash, randomUUID } from "node:crypto";
import {
  IMPLICIT_COMPANY_ID, LEARNED_CONTEXT_FEATURE, LESSONS_WORKER_DEADLINE_SECONDS, codeRepositoriesOf, companyScoped, orgProjectCatalogKey, learnedLoadReportOfProgress,
  type Admission, type IdentityProvider, type ApprovalProof, type ApprovalRequest, type Approvers, type AuditSink, type LearnedContext, type LearningAdapter, type Metering, type ModelKeyStore, type ObjectStorage, type OrgId, type Principal, type RegistryView,
} from "@agentx/contracts";
import type { ModelProviderBook } from "../model-proxy/types.js";
import type { LocalModelChoice } from "../model-choice.js";
import type { ProviderEndpoints } from "../model-proxy/providers.js";
import type { DocumentMilestones } from "../../core/milestones/milestones.js";
import type { LessonReposView, LocalActionResult, LessonView as PageLessonView } from "../../core/local-pages/views.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { taskPointerKey } from "../../core/task-flow/keys.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type TaskPointerRecord, type TaskRecord } from "../../core/task-flow/records.js";
import { textReaderOf } from "../../core/build-step/plan-input.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { applyLoadReport, recordFeedback } from "../../lessons/counters.js";
import { LOCAL_SESSION_METHOD } from "../../ports/policy-defaults.js";
import { approveLesson, retireByPerson } from "../../lessons/approve.js";
import { learnedContextForDispatch } from "../../lessons/load.js";
import { readVisible } from "../../lessons/read-visible.js";
import { modeAllows, requireAudit, resolveLearning, setLearnedLessonsGate } from "../../lessons/policy.js";
import { createLessonsRuntime, type LessonsRuntime } from "../../lessons/runtime.js";
import { documentReflectClaims } from "../../lessons/reflect-claims.js";
import { reflectQueueOf, queueReflectQueue, queueReflectVisibility } from "../../lessons/reflect-queue.js";
import { retryDelayFor, runReflectMessage, type ReflectWorkerDeps } from "../../lessons/reflect-worker.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskEndOutcome, type TaskLearningDeps } from "../../lessons/task-end.js";
import { buildLessonsView } from "../../lessons/view.js";
import { repoFileAction, repoFileStatus } from "../../lessons/repo-file-routes.js";
import { lessonsUsedReaderOver, lessonsUsedSection, type LessonsUsedSummary, type RepositoryVisibility } from "../../lessons/used-in-pr.js";
import { localLessonsEnabled } from "../../lessons/switch.js";
import { documentRepoFileStore } from "../../lessons/document-repo-file.js";
import { lessonsRepoFilePublishJob, lessonsRepoFileSweepJob, type RepoFileRuntime } from "../../lessons/repo-file-job.js";
import { planLoadFacts } from "../../lessons/plan-facts.js";
import { createLocalPipelineModel, createLocalLearningSpend } from "./lessons-model.js";
import { createLessonRepositories, type LessonRepositories } from "./lessons-repos.js";
import { createLocalLessonSources } from "./lessons-sources.js";
import type { CodeFactsReader } from "../../lessons/code-facts.js";
import type { LessonsUsedSection } from "../../core/proof/pull-request-body.js";
import type { PrCommandWorld } from "../../core/pr-commands/handler.js";
import type { Lesson } from "../../lessons/types.js";

/** The longest a step's dispatch waits for the loader: a slow load sends nothing, and the step runs as it would without lessons. */
export const LESSON_LOAD_DEADLINE_MS = 2_500;
/** The messages one pass of the timer takes off the reflection queue. */
const REFLECT_PER_PASS = 2;
const LOAD_RECORD_KEEP_SECONDS = 30 * 86_400;
const INTENT_REQUEST_CHARS = 600;

/** The workflow modes that carry lessons, and the lesson stage each is. Every other mode (the checks, a publication) carries none. */
const STAGES: Readonly<Record<string, "UNDERSTAND" | "PLAN" | "IMPLEMENT" | "REVIEW">> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", REVIEW: "REVIEW" };

export interface LocalLessonsOptions {
  flow: TaskFlowDeps;
  registry: RegistryView;
  companyId?: OrgId;
  owner: Principal;
  blobs: ObjectStorage;
  milestones: Pick<DocumentMilestones, "register">;
  audit: AuditSink;
  admission: Admission;
  metering: Metering;
  approvers: Approvers;
  /** Who a code host account is: a person's `/rovara lesson` comment is theirs, not the owner's. */
  identity: Pick<IdentityProvider, "resolveExternalAccount">;
  /** The model the install's steps use, and what the call needs (the same pieces an Ask's call has). */
  model: { choice: () => Promise<LocalModelChoice | undefined>; keys: ModelKeyStore; providers: ModelProviderBook; endpoints?: Partial<ProviderEndpoints> | undefined; fetch?: typeof fetch | undefined };
  learning?: LearningAdapter | undefined;
  /** Whether lessons are switched on (default: on unless the `ROVARA_LESSONS` environment variable is `0`, read at each ask). */
  enabled?: () => boolean;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** What one lesson's approval form is bound to: the lesson's own text and version, so an approval applies to what the person read. */
export interface LessonOffer { requestId: string; revision: number; artifactDigest: string; risk: "low" | "medium" | "high" }

/** A lesson on the owner's lessons page: the page's own view type, plus what the approval form needs. */
export interface LocalLessonView extends PageLessonView {
  project: string;
  title: string;
  /** The way the owner can decide it: present only for a lesson that waits for a person. */
  offer?: LessonOffer;
}

export interface LocalLessons {
  readonly runtime: LessonsRuntime;
  readonly repositories: LessonRepositories;
  enabled(): boolean;
  /** The lessons of every project, newest first, for the owner's page. */
  list(): Promise<LocalLessonView[]>;
  /** One decision from the owner's page. `proof` is the page's signed proof for an approval. */
  act(input: { lessonId: string; action: "approve" | "retire" | "wrong"; proof?: ApprovalProof | undefined; offer?: LessonOffer | undefined }): Promise<LocalActionResult>;
  /** The repository lessons file switches of each project, for the lessons page. */
  repoSwitches(): Promise<LessonReposView[]>;
  /** One switch from the lessons page. Switching on needs `fresh`: a page session opened in the last few minutes. */
  repoSwitch(input: { project: string; repo: string; action: "on" | "off" | "resume" | "pointer_add" | "pointer_decline"; fresh: boolean }): Promise<LocalActionResult>;
  /** What the dispatch of a step asks: the lessons to give it (ids are the library's; the worker gets text). `features` are the worker's. */
  learnedFor(input: { workspaceId: string; operationId: string; workflowMode: string | undefined; features: readonly string[] }): Promise<{ learnedContext?: LearnedContext }>;
  /** What the callbacks tell after a batch of a worker's events: the load report of a step, applied to the manifest its dispatch recorded. Never throws. */
  onEvents(operation: { workspaceId: string; id: string }, events: ReadonlyArray<{ type: string; payload: unknown }>): Promise<void>;
  /** The "Lessons used" section of a task's pull request description. `undefined` for no section. Never throws. */
  usedInPullRequest(task: Pick<TaskRecord, "taskId" | "project" | "startingRevision">, repositoryId: string): Promise<LessonsUsedSection | undefined>;
  /** `/rovara lesson <n> wrong|right|retire`, from a writer's comment on a pull request of the task. */
  command: PrCommandWorld["lesson"] extends (input: infer I) => Promise<LocalActionResult> ? (input: I & { taskId: string }) => Promise<LocalActionResult> : never;
  /** One pass of the app's timer: the reflection queue and, once a day, the nightly upkeep. Never throws. */
  tick(): Promise<void>;
  /** A pull request of the task was reverted: the task is reflected on again, as a reverted one. */
  noteReverted(taskId: string): Promise<void>;
}

const jsonHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The fixed lesson text a decision is bound to: its title, description and body at its version. */
const digestOf = (lesson: Pick<Lesson, "title" | "description" | "body" | "version">): string => jsonHash([lesson.title, lesson.description, lesson.body, lesson.version]);

const statusOf = (status: Lesson["status"]): PageLessonView["status"] => (status === "pending" || status === "candidate" ? "proposed" : status === "active" || status === "stale" ? "active" : "retired");

export function createLocalLessons(options: LocalLessonsOptions): LocalLessons {
  const { flow, registry, owner, now } = options;
  const companyId = options.companyId ?? (IMPLICIT_COMPANY_ID);
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.({ component: "lessons", event, ...fields });
  const enabled = options.enabled ?? (() => localLessonsEnabled());
  // The library asks the same switch before every learning call (with it off no model call is made, whoever asks), so the one the install gives is the one it asks.
  setLearnedLessonsGate(() => enabled());
  const repositories = createLessonRepositories({ flow, registry, companyId, now });
  const ownerId = owner.personId;
  const readText = textReaderOf(options.blobs);

  // What the code host can read of a repository at a commit, for the citations and the code facts.
  const reader: CodeFactsReader = {
    async file(input) {
      const repo = (await repositories.ofProject(input.project)).find((candidate) => candidate.name === input.repo);
      return repo === undefined ? undefined : repo.codeHost.fileAtRevision(repo.repository, input.path, input.commit, repo.scope, { timeoutMs: input.timeoutMs });
    },
    async kind(input) {
      const repo = (await repositories.ofProject(input.project)).find((candidate) => candidate.name === input.repo);
      if (repo === undefined || repo.codeHost.pathKind === undefined) return undefined;
      const kind = await repo.codeHost.pathKind(repo.repository, input.path, input.commit, repo.scope, { timeoutMs: input.timeoutMs });
      return kind === "symlink" ? undefined : kind;
    },
  };

  const taskProject = async (_workspaceId: string, taskId: string): Promise<string | undefined> => {
    const task = await readTask(flow, taskId);
    return task === undefined || task.companyId !== companyId ? undefined : task.project;
  };

  const model = createLocalPipelineModel({ choice: options.model.choice, keys: options.model.keys, companyId, providers: options.model.providers, endpoints: options.model.endpoints, fetch: options.model.fetch, now, metering: options.metering });
  const spend = createLocalLearningSpend(options.admission, companyId);
  const sources = createLocalLessonSources({ flow, companyId, ownerId, repos: repositories, readObject: (key, max) => readText(key, max), now, log: (event, fields) => log(event, fields) });

  const runtime = createLessonsRuntime({
    store: flow.store, companyId, now, log: (event, fields) => log(event, fields), audit: options.audit, reader,
    repositoriesOf: async (_workspaceId, project) => {
      const latest = await flow.projects.latest(project);
      return latest === undefined ? [] : codeRepositoriesOf(latest.definition).map((repository) => repository.name);
    },
    owner: { id: ownerId, name: owner.displayName }, taskProject, projectRepoScopes: repositories.scopes(), model, spend, learning: options.learning,
    // A reason that was recorded is cleared when it is read once its cause is gone (a provider was connected).
    pauseStillApplies: async (_workspaceId, _project, code) => (code === "no_provider" ? (await options.model.choice()) === undefined : true),
  });

  // The lessons file of each repository: off per repository until the owner switches it on, then one weekly pull request that proposes the lessons learned only from that repository's own words.
  const repoFile: RepoFileRuntime = {
    deps: {
      store: runtime.store, state: documentRepoFileStore(flow.store, { onUnreadable: (what) => log("repo_file_item_unreadable", { what }) }), settings: runtime.settings, audit: runtime.audit, now, log: (event, fields) => log(event, fields),
      // The people a lesson could name are the owner and the accounts its words came from; a name that cannot be read stops the pass, so the owner's is always given.
      names: async () => [owner.displayName],
    },
    newHolder: () => `local-${randomUUID()}`,
    targets: (_workspaceId, project) => repositories.targets(project),
  };
  runtime.repoFile = repoFile;

  // ---- capture: the queue, the lease and the worker

  let reflectQueue: ReturnType<typeof queueReflectQueue> | undefined;
  let queuePromise: ReturnType<typeof reflectQueueOf> | undefined;
  const queueOf = (): ReturnType<typeof reflectQueueOf> => (queuePromise ??= reflectQueueOf(registry.require("queue")));
  const sender = async (): Promise<ReturnType<typeof queueReflectQueue>> => (reflectQueue ??= queueReflectQueue(await queueOf()));

  const claims = documentReflectClaims({ store: flow.store, keysOutcome: async () => "clear" });
  const learning: TaskLearningDeps = {
    source: sources.source, rows: sources.rows, settings: runtime.settings,
    reflect: { model, spend, audit: runtime.audit, settings: runtime.settings, edition: runtime.edition, now, pause: runtime.pause },
    process: runtime.process, counters: runtime.counters, log: (event, fields) => log(event, fields),
  };
  const workerDeps = (visibility?: ReflectWorkerDeps["visibility"]): ReflectWorkerDeps => ({
    claims, learn: (input) => learnFromEndedTaskTyped(learning, input), now, deadlineMs: LESSONS_WORKER_DEADLINE_SECONDS * 1000,
    ...(visibility === undefined ? {} : { visibility }), log: (event, fields) => log(event, fields),
  });

  async function pumpReflections(): Promise<void> {
    const queue = await queueOf();
    const visibility = queueReflectVisibility(queue);
    const received = await queue.receive({ maxMessages: REFLECT_PER_PASS, visibilityTimeoutSeconds: 10 * 60 });
    for (const message of received) {
      const outcome = await runReflectMessage(workerDeps(visibility), JSON.stringify(message.body)).catch(() => ({ result: "failed" as const, retry: true }));
      if (outcome.retry) await queue.changeVisibility(message.receiptHandle, retryDelayFor(message.receiveCount, "retryAt" in outcome ? outcome.retryAt : undefined, now())).catch(() => undefined);
      else await queue.ack(message.receiptHandle).catch(() => undefined);
    }
  }

  const onTaskEnd = learningTaskEndHandler(() => ({ queue: { send: async (message) => (await sender()).send(message) }, log: (event, fields) => log(event, fields) }));
  const endOf = (kind: string): TaskEndOutcome | undefined => (kind === "merged" ? "merged" : kind === "closed" ? "closed" : undefined);
  options.milestones.register({
    name: "lessons",
    async on(milestone) {
      // Behind the switch: with it off nothing is queued, so no later switching-on finds a backlog of old tasks to pay for.
      if (!enabled()) return;
      const outcome = endOf(milestone.kind);
      if (outcome === undefined) return;
      const task = await readTask(flow, milestone.taskId);
      if (task === undefined || task.companyId !== companyId) return;
      const resolved = await resolveLearning(runtime.settings, companyId, task.project);
      if (!modeAllows(resolved.mode, "reflect")) return;
      await onTaskEnd({ orgId: companyId, taskId: milestone.taskId, outcome });
    },
  });

  // ---- the owner's page and decisions

  async function projectNames(): Promise<string[]> {
    const page = await flow.store.query({ pk: orgProjectCatalogKey(companyId, "x").pk, limit: 200 }).catch(() => ({ items: [] as Array<{ sk: string }> }));
    const named = page.items.map((item) => item.sk).filter((sk) => sk.startsWith("PROJECT#")).map((sk) => sk.slice("PROJECT#".length));
    return named;
  }

  async function locate(lessonId: string): Promise<{ project: string; lesson: Lesson } | undefined> {
    const viewer = await runtime.directory.identity(companyId, ownerId);
    for (const project of await projectNames()) {
      const key = { workspaceId: companyId, project };
      const lesson = await runtime.store.get(key, lessonId);
      // A lesson the owner cannot read now (its sources are hidden from them) is not there for them either.
      if (lesson !== undefined && (await readVisible({ access: runtime.access, key, viewer, lessons: [lesson], where: "page" }).catch(() => [])).length === 1) return { project, lesson };
    }
    return undefined;
  }

  const offerOf = (lesson: Pick<Lesson, "id" | "version" | "tier" | "title" | "description" | "body">): LessonOffer => ({
    requestId: `lesson:${lesson.id}:${String(lesson.version)}`, revision: lesson.version, artifactDigest: digestOf(lesson),
    // A tier-0 lesson is a cited fact; a tier-2 lesson reaches reviewers or checks, so approving it is a higher-risk act.
    risk: lesson.tier === 0 ? "low" : lesson.tier === 1 ? "medium" : "high",
  });

  async function list(): Promise<LocalLessonView[]> {
    const views: LocalLessonView[] = [];
    for (const project of await projectNames()) {
      let view;
      try { view = await buildLessonsView(runtime.routes, { orgId: companyId, developerId: ownerId }, project); } catch { continue; }
      for (const group of [view.waiting, view.active, view.removed]) {
        for (const card of group) {
          const scope = [...(card.scope.repos ?? []), ...(card.scope.paths ?? [])].join(", ");
          views.push({
            id: card.id, project, title: card.title, text: `${card.title}: ${card.description === "" ? "" : `${card.description} `}${card.body}`, scope: scope === "" ? `${project}: everywhere in the project` : `${project}: ${scope}`, status: statusOf(card.status),
            usedIn: await usedIn(project, card.id),
            ...(card.status === "pending" ? { offer: offerOf(card) } : {}),
            ...(await retireAsked(project, card.id, statusOf(card.status))),
          });
        }
      }
    }
    return views;
  }

  /** A person's comment asked for this lesson to be retired and nobody has yet: the page says so beside its Retire button. */
  async function retireAsked(project: string, lessonId: string, status: PageLessonView["status"]): Promise<{ retireRequest?: { by: string; pullRequest: number } }> {
    if (status === "retired") return {};
    const row = await flow.store.get(retireAskKey(project, lessonId)).catch(() => undefined);
    return row !== undefined && typeof row["by"] === "string" && typeof row["pullRequest"] === "number" ? { retireRequest: { by: row["by"], pullRequest: row["pullRequest"] } } : {};
  }

  /** The tasks that loaded a lesson, newest first (a few: the page shows five). */
  async function usedIn(project: string, lessonId: string): Promise<Array<{ taskId: string; title: string }>> {
    const used: Array<{ taskId: string; title: string; at: number }> = [];
    const page = await flow.store.query({ pk: companyScoped(companyId, `LESSON_USE#${project}#${lessonId}`), descending: true, limit: 10 }).catch(() => ({ items: [] as Array<Record<string, unknown>> }));
    for (const item of page.items) if (typeof item["taskId"] === "string") used.push({ taskId: item["taskId"], title: typeof item["title"] === "string" ? item["title"] : "", at: typeof item["at"] === "number" ? item["at"] : 0 });
    return used.sort((a, b) => b.at - a.at).slice(0, 5).map(({ taskId, title }) => ({ taskId, title }));
  }

  const refuse = (message: string, reason: "refused" | "not_found" | "stale" | "invalid" = "refused"): LocalActionResult => ({ ok: false, reason, message });
  const failureWords = (code: string): string => ({
    not_found: "That lesson is no longer there.", not_pending: "That lesson is not waiting for a decision.", mode_off: "Lessons are off for this project.", not_eligible: "You cannot decide this lesson.",
    already_approved: "That was already approved.", author_cannot_approve_alone: "A lesson needs someone other than the person who wrote it.", second_person_required: "This lesson needs a second person to approve it.",
    sole_owner_cool_off: "This lesson can be approved by you alone after a short wait.", eligibility_unavailable: "Rovara could not tell who may decide this. Try again.", capability_request: "This lesson asks for more than advice, so it needs a second look.",
    conflict: "This lesson changed since you read it. Read it again and decide again.", tier_never: "That lesson cannot be approved.", not_permitted: "You cannot see where this lesson came from, so you cannot decide it.",
    audit_unavailable: "That could not be recorded, so nothing was changed.", cannot_merge: "Those two lessons cannot be merged.",
  } as Record<string, string>)[code] ?? "That was not accepted.";

  async function act(input: Parameters<LocalLessons["act"]>[0]): Promise<LocalActionResult> {
    const found = await locate(input.lessonId);
    if (found === undefined) return refuse("That lesson is no longer there.", "not_found");
    const { project, lesson } = found;
    const where = { workspaceId: companyId, project, lessonId: lesson.id };
    if (input.action === "retire" || input.action === "wrong") {
      // Retiring is a kill switch: it needs no proof, only the owner's own form, and it always works.
      const retired = await retireByPerson(runtime.routes, { ...where, actorId: ownerId, reason: input.action === "wrong" ? "marked wrong by its owner" : "retired by its owner" });
      return retired.ok ? { ok: true, message: "That lesson is retired." } : refuse(failureWords(retired.code));
    }
    if (lesson.status !== "pending") return refuse("That lesson is not waiting for a decision.", "stale");
    // An approval is the owner's act on what they read: the proof the page signed names this lesson's text and version, and the approvers point decides whether it is a proof of the owner's.
    const offer = offerOf(lesson);
    if (input.proof === undefined || input.offer === undefined) return refuse("A lesson is approved on its own page form, which this was not.");
    if (input.offer.requestId !== offer.requestId || input.offer.artifactDigest !== offer.artifactDigest || input.offer.revision !== offer.revision) {
      return refuse("This changed since you read it. Read the latest and decide again.", "stale");
    }
    const request: ApprovalRequest = { companyId, requestId: offer.requestId, kind: "lesson", subject: { type: "lesson", id: lesson.id }, projectName: project, revision: offer.revision, artifactDigest: offer.artifactDigest, risk: offer.risk, outcome: "approve" };
    const requirement = await options.approvers.requirement(request).catch(() => undefined);
    // Only the page's own proof counts here: a comment or any other way the approvers point might list is not the owner on their page.
    if (requirement === undefined || input.proof.method !== LOCAL_SESSION_METHOD || !requirement.methods.includes(input.proof.method)
      || (request.risk === "high" && requirement.strongMethods !== undefined && !requirement.strongMethods.includes(input.proof.method))) return refuse("That way of approving is not allowed for a lesson.");
    const verdict = await options.approvers.verify(request, input.proof).catch(() => ({ approved: false as const, reason: "unavailable" }));
    if (!verdict.approved) return refuse("That was not accepted.");
    const approved = await approveLesson(runtime.routes, { ...where, approverId: verdict.approver.personId === owner.personId ? ownerId : verdict.approver.personId, expectedVersion: offer.revision });
    if (!approved.ok) return refuse(failureWords(approved.code), approved.code === "conflict" ? "stale" : "refused");
    return { ok: true, message: approved.status === "active" ? "Approved. Rovara will use this lesson." : "Approved. It needs one more person before it is used." };
  }

  // ---- the repository lessons file, on the page

  async function repoSwitches(): Promise<LessonReposView[]> {
    const repoFile = runtime.repoFile;
    if (repoFile === undefined) return [];
    const views: LessonReposView[] = [];
    for (const project of await projectNames()) {
      try {
        const status = await repoFileStatus(repoFile, { workspaceId: companyId, project });
        views.push({ project, canEnable: status.canEnable, repos: status.repos.map((row) => ({ repo: row.repo, enabled: row.enabled, fileDeleted: row.fileDeleted, pointer: row.pointer, notices: row.notices })), available: status.available });
      } catch { /* a project whose repositories cannot be read now shows no switches */ }
    }
    return views;
  }

  async function repoSwitch(input: Parameters<LocalLessons["repoSwitch"]>[0]): Promise<LocalActionResult> {
    const repoFile = runtime.repoFile;
    if (repoFile === undefined) return refuse("Lessons are not available for this project.", "not_found");
    // Switching on makes Rovara open pull requests in a repository: it needs the owner's page opened a few minutes ago (a form with a fresh session), never the API token.
    if (input.action === "on" && !input.fresh) return refuse("Switching this on needs a page you opened in the last few minutes.");
    const result = await repoFileAction(repoFile, { workspaceId: companyId, project: input.project }, { action: input.action, repo: input.repo });
    if (result.ok) return { ok: true, message: "Saved." };
    return refuse(({
      not_found: "No such repository in this project.", unreadable: "Rovara cannot read this project's repositories right now. Try again.", host_cannot_write: "This repository's code host cannot take a pull request from Rovara.",
      audit_unavailable: "That could not be recorded, so nothing changed.", conflict: "This setting changed while you were looking at it. Read the page again.",
    } as const)[result.code], result.code === "not_found" ? "not_found" : result.code === "conflict" ? "stale" : "refused");
  }

  // ---- loading, at the dispatch of a step

  async function learnedFor(input: Parameters<LocalLessons["learnedFor"]>[0]): Promise<{ learnedContext?: LearnedContext }> {
    const stage = input.workflowMode === undefined || !Object.hasOwn(STAGES, input.workflowMode) ? undefined : STAGES[input.workflowMode];
    if (stage === undefined || !enabled() || !input.features.includes(LEARNED_CONTEXT_FEATURE)) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pointer = fromDocument<TaskPointerRecord>(await flow.store.get(taskPointerKey(input.workspaceId)));
      const task = pointer === undefined ? undefined : await readTask(flow, pointer.taskId);
      if (task === undefined || task.companyId !== companyId || task.workflow === undefined) return {};
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
        const at = Math.floor(now() / 1000);
        if (abandoned) return {};
        await flow.store.put({ item: { pk: companyScoped(companyId, "LESSON_LOAD"), sk: input.operationId, entityType: "LESSON_LOAD_REF", taskId: task.taskId, project: task.project, stage, round, ...(flow.store.ttlAttribute === undefined ? {} : { [flow.store.ttlAttribute]: at + LOAD_RECORD_KEEP_SECONDS }) } });
        for (const lesson of loaded.learnedContext.lessons) {
          if (abandoned) return {};
          await flow.store.put({ item: { pk: companyScoped(companyId, `LESSON_USE#${task.project}#${lesson.id}`), sk: task.taskId, entityType: "LESSON_USE", taskId: task.taskId, title: task.title.slice(0, 200), at: now(), ...(flow.store.ttlAttribute === undefined ? {} : { [flow.store.ttlAttribute]: at + 180 * 86_400 }) } }).catch(() => undefined);
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

  const usedReader = lessonsUsedReaderOver({
    store: runtime.store, settings: runtime.settings, access: runtime.access, commands: true, names: runtime.routes.names,
    visibility: async (_orgId, project): Promise<RepositoryVisibility> => {
      const found = await repositories.ofProject(project);
      if (found.length === 0) return "unknown";
      if (found.some((repository) => repository.private === false)) return "public";
      return found.every((repository) => repository.private === true) ? "private" : "unknown";
    },
  });
  async function usedSummary(task: Pick<TaskRecord, "taskId" | "project" | "startingRevision">, repositoryId: string): Promise<LessonsUsedSummary | undefined> {
    return usedReader({ orgId: companyId, project: task.project, taskId: task.taskId, pageUrl: undefined, repo: repositoryId, startingRevision: task.startingRevision });
  }
  // The numbers a pull request shows are the position in the list written into its description. That list is kept as it was written, so a comment's number means what the person read, even after
  // the lessons held, or a later round's list, have moved on.
  const listKey = (taskId: string, repositoryId: string) => ({ pk: companyScoped(companyId, `LESSON_LIST#${taskId}`), sk: repositoryId });
  async function recordList(task: Pick<TaskRecord, "taskId" | "project">, repositoryId: string, ids: readonly string[]): Promise<void> {
    const at = Math.floor(now() / 1000);
    await flow.store.put({ item: { ...listKey(task.taskId, repositoryId), entityType: "LESSON_LIST", project: task.project, ids: [...ids], ...(flow.store.ttlAttribute === undefined ? {} : { [flow.store.ttlAttribute]: at + 180 * 86_400 }) } }).catch(() => undefined);
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

  const RETIRE_ASK_KEEP_SECONDS = 30 * 86_400;
  const retireAskKey = (project: string, lessonId: string) => ({ pk: companyScoped(companyId, `LESSON_RETIRE_ASK#${project}`), sk: lessonId });

  const command: LocalLessons["command"] = async (input) => {
    const task = await readTask(flow, input.taskId);
    if (task === undefined || task.companyId !== companyId) return refuse("That is no longer there.", "not_found");
    // The comment is its author's, never the owner's: the author is who the identity point says that host account is, and an account it does not know does nothing here.
    const person = await options.identity.resolveExternalAccount(companyId, input.author).catch(() => undefined);
    if (person === undefined || person.companyId !== companyId) return refuse("Rovara does not know which person that account is, so it cannot act on a lesson for it. Link the account, then ask again.");
    const pullRequest = (task.workflow?.pullRequests ?? []).find((entry) => entry.number === input.number);
    const recorded = pullRequest === undefined ? undefined : await flow.store.get(listKey(task.taskId, pullRequest.repositoryId)).catch(() => undefined);
    const ids = recorded === undefined || !Array.isArray(recorded["ids"]) ? undefined : (recorded["ids"] as unknown[]);
    // The number is the position in the "Lessons used" list as it was written into this pull request's description.
    const lessonId = ids?.[input.lessonNumber - 1];
    if (typeof lessonId !== "string" || typeof recorded?.["project"] !== "string") return refuse(`This pull request does not list a lesson number ${String(input.lessonNumber)}.`, "not_found");
    const project = recorded["project"];
    const where = { workspaceId: companyId, project, lessonId };
    if (input.verdict === "retire") {
      // Retiring cannot be undone in Code, and it is the owner's act on their page. A comment only asks: nothing changes until the owner presses Retire there.
      const lesson = await runtime.store.get({ workspaceId: companyId, project }, lessonId);
      if (lesson === undefined || lesson.status === "retired") return refuse("That lesson is no longer there.", "not_found");
      if (!await requireAudit(runtime.routes.audit, { action: "lesson.retire_requested", workspaceId: companyId, project, lessonId, actor: person.personId, facts: { pullRequest: input.number, via: "comment" } })) return refuse(failureWords("audit_unavailable"));
      const at = Math.floor(now() / 1000);
      await flow.store.put({ item: { ...retireAskKey(project, lessonId), entityType: "LESSON_RETIRE_ASK", by: person.displayName.slice(0, 80), personId: person.personId, pullRequest: input.number, at: now(), ...(flow.store.ttlAttribute === undefined ? {} : { [flow.store.ttlAttribute]: at + RETIRE_ASK_KEEP_SECONDS }) } });
      return { ok: true, message: "Noted. A lesson is retired by the owner, on the lessons page: it will show your request there." };
    }
    const identity = await runtime.directory.identity(companyId, person.personId);
    const marked = await recordFeedback({ ...runtime.counters, access: runtime.access }, { ...where, taskId: task.taskId, userId: person.personId, viewer: identity, kind: input.verdict === "wrong" ? "wrong_here" : "helpful", projectMember: true });
    if (marked.ok) return { ok: true, message: input.verdict === "wrong" ? "Thanks. Rovara marked that lesson as not helpful here." : "Thanks. Rovara marked that lesson as helpful." };
    return refuse(marked.code === "repeat" ? "That lesson was already marked." : "That lesson could not be marked.");
  };

  // ---- the timer's pass

  let lastNightly = 0;
  let running = false;
  async function tick(): Promise<void> {
    if (running || !enabled()) return;
    running = true;
    try {
      await pumpReflections().catch((error: unknown) => log("reflect_pass_failed", { error: error instanceof Error ? error.name : "unknown" }));
      if (now() - lastNightly >= 24 * 3_600_000) {
        lastNightly = now();
        await nightly().catch((error: unknown) => log("nightly_failed", { error: error instanceof Error ? error.name : "unknown" }));
      }
    } finally {
      running = false;
    }
  }

  async function nightly(): Promise<void> {
    const names = await projectNames();
    const { sweepExpired } = await import("../../lessons/expiry.js");
    const { promoteStableTrials } = await import("../../lessons/trial.js");
    for (const project of names) {
      const key = { workspaceId: companyId, project };
      const resolved = await resolveLearning(runtime.settings, companyId, project);
      if (!modeAllows(resolved.chosenMode, "capture")) continue;
      await sweepExpired({ ...runtime.counters, vectors: runtime.vectors }, runtime.store, key, {}).catch(() => undefined);
      await promoteStableTrials({ ...runtime.counters, store: runtime.store }, key).catch(() => undefined);
    }
    // The erasure sweep comes first and has its own budget; then the weekly lessons file pass (each repository is off until the owner switches it on).
    const day = Math.floor(now() / 86_400_000);
    await lessonsRepoFileSweepJob(repoFile, companyId, names, 60_000, day).catch(() => undefined);
    await lessonsRepoFilePublishJob(repoFile, companyId, names, 120_000, day).catch(() => undefined);
  }

  async function noteReverted(taskId: string): Promise<void> {
    if (!enabled()) return;
    try { await (await sender()).send({ orgId: companyId, taskId, outcome: "reverted", requestId: randomUUID() }); } catch { log("revert_not_queued"); }
  }

  return { runtime, repositories, enabled, list, act, repoSwitches, repoSwitch, learnedFor, onEvents, usedInPullRequest, command, tick, noteReverted };
}
