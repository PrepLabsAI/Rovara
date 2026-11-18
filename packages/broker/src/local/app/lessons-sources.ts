// What a finished task tells lessons, read from what this install records: the task and its workflow (the request, the approved plan, the reviews' findings, the decisions, the pull requests) and, from the code host,
// the review comments on the task's merged pull requests. Nothing is read from anywhere a person did not already put it on this machine.
//
// The rules a hosted install's source follows, in this one-person form:
// - Only a task of this company with a workflow teaches. A task that was never started by a person teaches nothing.
// - The owner's own words (the request, a send-back's reason, a close reason) are a member's. Words an agent wrote (the plan, the reviews' findings, a check's text) are `system`: advice, never a person's correction.
// - A reviewer's comment on a pull request is a member's only when the code host says its author is a person with write or admin standing in that repository; every other comment keeps the class `outsider`, which the reflector
// removes before any model call. A comment's place is the repository's, and its readers are that repository's readers (a restricted audience with no names, which the project's own repositories turn into "the project").
// - A host that cannot list the comments, or whose standing cannot be read, gives no comment span. Nothing here guesses.
// - Ticket comments (L4-SRC-TK, weak, only with `tickets`): at the end of a task that a TICKET started (intake's strict rule), the comments on that one ticket, by the checks of `lessons/ticket-comments.ts`. Never for a paused source.
import { OrgIdSchema, type ChangeRequestRef, type CodeHost, type HostAccount, type HostScope, type OrgId, type Tracker, type TrackerItemRef, type WorkflowSnapshot } from "@agentx/contracts";
import { WORKFLOW_REDIRECT_PLAN_DECISION_REASON, WORKFLOW_REVISE_PLAN_DECISION_REASON, WORKFLOW_SPEC_REPLAN_DECISION_REASON, isRovareReplyComment } from "@agentx/contracts";
import { PAGE_CHANGES_DEFAULT_REASON } from "../../developer/gate-default-reasons.js";
import { taskOwnerKey } from "../../developer/task-records.js";
import { providerOf } from "../../plugins/routing.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { changeRequestRef, readChangeRequestFiles } from "../../core/merge/host-port.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { readOwnerFindingNotes } from "../../core/task-flow/owner-note.js";
import { readTask } from "../../core/task-flow/reads.js";
import { originTicketOf } from "../../core/ticket-updates/handler.js";
import type { TaskRecord } from "../../core/task-flow/records.js";
import { looksLikeCorrection } from "../../lessons/correction-filter.js";
import { isEvalRunMark } from "../../lessons/eval-run.js";
import { isHumanSendBack } from "../../lessons/human-send-backs.js";
import { ticketCommentSpans, type TicketCommentRow } from "../../lessons/ticket-comments.js";
import { cleanForLearning } from "../../lessons/guards.js";
import type { EvidenceSpan } from "../../lessons/reflect-input.js";
import type { OutcomeRowReader, RevertedTasksReader } from "../../lessons/task-outcome-rows.js";
import type { TaskSubjectBase, TaskSubjectSource } from "../../lessons/task-end.js";
import type { SendBackFact } from "../../lessons/task-subject.js";
import type { Audience, TrustClass } from "../../lessons/types.js";
import type { LessonRepositories, LessonRepository } from "./lessons-repos.js";
import type { HostedLessonPeople } from "../../lessons/hosted-people.js";
import { queryAll } from "@agentx/contracts";

const PLAN_MAX_BYTES = 70_000;
const MAX_FINDINGS = 20;
const MAX_CI_PROBLEMS = 10;
const MAX_SEND_BACK_IDS = 50;
/** At most this many plan or design comments are read from one task (the newest). One total limit; each is already at most 500 characters. */
const MAX_PLAN_COMMENTS = 10;
/**
 * The reasons code itself writes on a gate's REQUEST_CHANGES decision when no person typed words (a default for an empty box, a plan revised for a live change or a redirect, a re-plan for an edited spec): code's
 * sentences, never a person's correction, and they carry no `source`, so they are recognised by their words. A person who typed exactly one of them teaches nothing either (fail closed).
 */
const CODE_GATE_REASONS: ReadonlySet<string> = new Set(["Changes requested.", PAGE_CHANGES_DEFAULT_REASON, WORKFLOW_REVISE_PLAN_DECISION_REASON, WORKFLOW_REDIRECT_PLAN_DECISION_REASON, WORKFLOW_SPEC_REPLAN_DECISION_REASON]);
const MAX_PULL_REQUESTS = 5;
/** ONE total limit on the changed file names a merged task's credit reads (every pull request together, a renamed file under both names); a bigger change leaves the list "not known". */
export const TOUCHED_PATHS_MAX = 2_000;
/** ONE total time for reading every merged pull request's file list. */
export const TOUCHED_READ_MS = 15_000;
const MAX_PULL_REQUEST_COMMENTS = 40;
const COMMENT_PATH_MAX = 200;
/** A findings answer's notes, joined, are read up to this many characters (one total limit; each note is already the person's, redacted at write). */
const FINDING_NOTES_TEXT_MAX = 4_000;
/** Words an agent wrote are advice at best: the class below Rovara's own structured signals. */
const AGENT_TEXT_TRUST: TrustClass = "system";
const CI_FAILURE_PREFIX = "A check failed on the change: ";

/** The task's life as times (creation to close); undefined when the record's times cannot be read. */
function lifetimeOf(task: TaskRecord): { from: number; to?: number } | undefined {
  const from = Date.parse(task.createdAt);
  if (!Number.isFinite(from)) return undefined;
  const to = task.closedAt === undefined ? undefined : Date.parse(task.closedAt);
  return to === undefined || !Number.isFinite(to) ? { from } : { from, to };
}

/** The most pages of an issue's comments one task end reads, and the longest the whole read may take. A ticket with more is not read at all (never a partial answer). */
const TICKET_PAGES_MAX = 5;
const TICKET_READ_MS = 20_000;

/**
 * What the ticket source needs of an install (L4-SRC-TK). `trackerFor` is the tracker registered under a system's name (the one intake and the ticket thread use); `personOfAccount` is the identity port's answer for a tracker's
 * own account id (the lessons' developer id of the person it is, undefined for anyone it cannot place, another company's person included); `paused` is the project's Pause of this source, read live (a read that fails answers true).
 */
export interface LessonTicketWiring {
  trackerFor(system: string): Tracker | undefined;
  scope: HostScope;
  personOfAccount(tracker: string, tenant: string, accountId: string): Promise<string | undefined>;
  paused(project: string): Promise<boolean>;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error("failed")); });
  });
}

/** Jira accounts are per site: its host is the account's tenant. Any other tracker has none. */
function tenantOf(tracker: string, url: string): string {
  if (tracker !== "jira") return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

function outcomeOf(workflow: WorkflowSnapshot | undefined): "merged" | "closed" | undefined {
  switch (workflow?.outcome) {
    case "MERGED": return "merged";
    case "CLOSED": case "REJECTED": return "closed";
    default: return undefined;
  }
}

/** The base commit when the record pins exactly one for the project's repositories; several repositories have several bases and the subject holds one, so none is claimed. */
function baseOf(task: TaskRecord, repositories: readonly string[]): { repository: string; commit: string } | undefined {
  const pinned = task.workflow?.reviewBase ?? task.preparedBase;
  if (pinned === undefined) return undefined;
  const mine = pinned.filter((entry) => repositories.includes(entry.repositoryId));
  return mine.length === 1 ? { repository: mine[0]!.repositoryId, commit: mine[0]!.baseCommitSha } : undefined;
}

/** The ACL source name of a code host: GitHub's own, or `codehost:<kind>` for any other (the lessons' audience schema names both). */
export const aclSourceOf = (provider: string): string => (provider === "github" ? "github" : `codehost:${provider}`);

/** A person on the code host, named the way this install names an account that is not the owner's (`<host>_<account id or login>`). */
const accountPerson = (provider: string, account: { login: string; hostUserId?: string | undefined }): string => `${provider}_${account.hostUserId ?? account.login}`.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 100);

export interface LocalSubjectSourceOptions {
  flow: Pick<TaskFlowDeps, "store" | "projects">;
  companyId: OrgId;
  /** The owner's id as lessons record it, and the host accounts that are the owner's own (the signed-in host account is a person, the owner). */
  ownerId: string;
  ownerAccounts?: ReadonlySet<string> | undefined;
  repos: LessonRepositories;
  /** The artifact store's text read (the plan document). Absent: no plan span. */
  readObject?: ((objectKey: string, maxBytes: number) => Promise<string | undefined>) | undefined;
  now: () => number;
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
  /** The ticket source (weak). Absent: ticket comments are not read. */
  tickets?: LessonTicketWiring | undefined;
  /**
   * An install of many people (the core engine on a deployed install). Each person's words are THEIRS: the request is the task's person's, a send-back's reason and a close reason are the deciding person's,
   * and each person's class is read NOW: a person on the project's roster is a member, anyone else an outsider (removed before any model call). An erased person's words are dropped, and a task whose person
   * is erased (or whose standing cannot be read) teaches nothing. A code host account is the person the port links it to, or a host account name. `ownerId` is then unused. Any read that fails throws.
   */
  hosted?: { people: HostedLessonPeople; personOfAccount?: (companyId: OrgId, provider: string, login: string) => Promise<string | undefined> } | undefined;
}

export interface LocalLessonSources { source: TaskSubjectSource; rows: OutcomeRowReader; reverts: RevertedTasksReader }

export function createLocalLessonSources(options: LocalSubjectSourceOptions): LocalLessonSources {
  const { flow, ownerId } = options;
  const company = (workspaceId: string): OrgId | undefined => { const parsed = OrgIdSchema.safeParse(workspaceId); return parsed.success && parsed.data === options.companyId ? parsed.data : undefined; };
  const teaches = (task: TaskRecord | undefined, workspaceId: string): task is TaskRecord =>
    task !== undefined && company(workspaceId) !== undefined && task.companyId === workspaceId && task.workflow !== undefined && !isEvalRunMark((task as { evalRun?: unknown }).evalRun);

  const hosted = options.hosted;
  /** A person's class now, or undefined when the person is erased (their words are not used). Local: the owner is the one member. */
  const standingOf = async (personId: string, project: string): Promise<TrustClass | undefined> => {
    if (hosted === undefined) return "member";
    if (await hosted.people.isErased(options.companyId, personId)) return undefined;
    return (await hosted.people.onProjectRoster(options.companyId, project, personId)) ? "member" : "outsider";
  };
  /** Who a decision of the workflow was made by: its actor on a hosted install, the owner on a laptop. */
  const deciderOf = (decision: { actorId?: string | undefined }): string | undefined => (hosted === undefined ? ownerId : decision.actorId);

  /** What kind of document a gate decision was about, from the artifact its digest binds: the plan, or a design (the requirements step is the design side of the pipeline). Undefined when the digest binds nothing known here. */
  const gateKindOf = (workflow: WorkflowSnapshot, digest: string | undefined): "plan_comment" | "design_comment" | undefined => {
    if (digest === undefined) return undefined;
    const type = workflow.artifacts.find((artifact) => artifact.sha256 === digest)?.type;
    if (type === "plan") return "plan_comment";
    return type === "design" || type === "requirements" ? "design_comment" : undefined;
  };

  /** The plan and design comments of a task, as spans (see the call). Only a person's own typed reason that reads as a correction (`correction-filter.ts`: praise, nits and bare questions are not). */
  async function planComments(task: TaskRecord, workflow: WorkflowSnapshot | undefined): Promise<EvidenceSpan[]> {
    if (workflow === undefined) return [];
    const spans: EvidenceSpan[] = [];
    const standings = new Map<string, TrustClass | undefined>();
    for (const decision of workflow.decisions) {
      if (decision.decision !== "REQUEST_CHANGES" || decision.actorRole === "AGENTX") continue;
      if (decision.source !== undefined && decision.source !== "GATE") continue;
      const reason = decision.reason.trim();
      if (reason === "" || CODE_GATE_REASONS.has(reason) || !looksLikeCorrection(reason)) continue;
      const kind = gateKindOf(workflow, decision.artifactDigest);
      // Only the TASK'S OWNER's own typed words. On a laptop the owner is the one person, but a repository collaborator's `/rovara changes` comment is recorded as a PROJECT_ADMIN decision, so it is never the owner's.
      // On a hosted install the owner's decision carries the owner key of the task (a hash of the task's person and the task), which names the task's person; any other decider's id cannot be resolved to a person: skipped.
      if (decision.actorRole !== "TASK_OWNER") continue;
      const person = hosted === undefined ? ownerId : decision.actorId === taskOwnerKey(task.developerId, task.taskId) ? task.developerId : undefined;
      if (kind === undefined || person === undefined) continue;
      if (!standings.has(person)) standings.set(person, await standingOf(person, task.project));
      // Erased (undefined) or off the roster (outsider): nothing of theirs is carried.
      if (standings.get(person) !== "member") continue;
      spans.push({ kind, text: reason, trust: "member", authorId: person, eventId: `task:${task.taskId}:plancomment:${decision.requestId}` });
    }
    return spans.slice(-MAX_PLAN_COMMENTS);
  }

  /** The comments of one pull request, as spans. */
  async function reviewComments(task: TaskRecord, pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number], repo: LessonRepository): Promise<EvidenceSpan[]> {
    const host: CodeHost = repo.codeHost;
    const ref: ChangeRequestRef = changeRequestRef(repo.url, pullRequest.number);
    let feedback;
    try { feedback = await host.feedback(ref, repo.scope); } catch { return []; }
    const provider = providerOf(host);
    const audience: Audience = { kind: "restricted", acl: { source: aclSourceOf(provider), scope: repo.place, capturedAt: new Date(options.now()).toISOString(), liveCheck: "none" } };
    const standing = new Map<string, TrustClass>();
    const trustOf = async (login: string): Promise<TrustClass> => {
      const known = standing.get(login);
      if (known !== undefined) return known;
      let trust: TrustClass = "outsider";
      try {
        const account: HostAccount = { login };
        const found = await host.standing(repo.repository, account, repo.scope);
        if ((found.permission === "write" || found.permission === "admin") && found.accountType === "person") trust = "member";
      } catch { trust = "outsider"; }
      standing.set(login, trust);
      return trust;
    };
    const spans: EvidenceSpan[] = [];
    for (const comment of feedback.comments.slice(0, MAX_PULL_REQUEST_COMMENTS)) {
      if (comment.body.trim() === "" || isRovareReplyComment(comment.body)) continue;
      let person: string;
      let trust: TrustClass;
      if (hosted !== undefined) {
        // On a hosted install a comment is a member's only when its account is linked to a person of the company who is on the project's roster now, and the code host also gives the account write
        // standing. An unlinked account is an outsider (its words are removed before any model call), and an erased person's comment is not read at all.
        const linked = await hosted.personOfAccount?.(options.companyId, provider, comment.author);
        if (linked === undefined) {
          person = accountPerson(provider, { login: comment.author });
          trust = "outsider";
        } else {
          const standingNow = await standingOf(linked, task.project);
          if (standingNow === undefined) continue;
          person = linked;
          trust = standingNow === "member" ? await trustOf(comment.author) : "outsider";
        }
      } else {
        trust = await trustOf(comment.author);
        person = options.ownerAccounts?.has(comment.author) === true ? ownerId : accountPerson(provider, { login: comment.author });
      }
      const place = comment.path === undefined ? undefined : cleanForLearning(comment.path, COMMENT_PATH_MAX);
      spans.push({
        kind: "pr_comment", text: place === undefined || place === "" ? comment.body : `On ${place}: ${comment.body}`, trust, authorId: person,
        eventId: `${repo.place}#pr${String(pullRequest.number)}:${comment.kind}${comment.id}`, audience, scopes: [repo.place], sourceKey: `${provider}:${person}`,
        ...(place === undefined || place === "" ? {} : { paths: [place] }),
      });
    }
    return spans;
  }

  /**
   * The files the task's merged pull requests changed, as the code host lists them (a renamed file under both names), and the project's names of the repositories they are in: for the area overlap of a clean merge's credit
   * (`lessons/credit.ts`). Only a LIST THAT IS WHOLE is given: every pull request of the task must be merged or closed (one still open, or whose state is not known, may be part of the change), at most `MAX_PULL_REQUESTS`
   * of them, each listed to its last page, within `TOUCHED_PATHS_MAX` names and `TOUCHED_READ_MS`. Anything else (a host that cannot list, a rate limit, a repository that cannot be placed, a cut list) is undefined, which
   * credits exactly as before this read existed. The repositories are this company's own (`options.repos` is built for it) and the host is called in the company's own scope.
   */
  async function touchedByMerge(task: TaskRecord, workflow: WorkflowSnapshot | undefined): Promise<{ paths: string[]; repos: string[] } | undefined> {
    const pullRequests = workflow?.pullRequests ?? [];
    const merged = pullRequests.filter((pullRequest) => pullRequest.state === "MERGED");
    if (merged.length === 0 || merged.length > MAX_PULL_REQUESTS || merged.length !== pullRequests.filter((pullRequest) => pullRequest.state !== "CLOSED").length) return undefined;
    const stopAt = Date.now() + TOUCHED_READ_MS;
    const beforeRequest = (): void => { if (Date.now() >= stopAt) throw new Error("touched paths: out of time"); };
    const paths = new Set<string>();
    const repos = new Set<string>();
    try {
      for (const pullRequest of merged) {
        const repo = await options.repos.ofTask(task.project, task.startingRevision, pullRequest.repositoryId);
        if (repo === undefined) return undefined;
        const read = await readChangeRequestFiles(repo.codeHost, changeRequestRef(repo.url, pullRequest.number), repo.scope, beforeRequest);
        if (!read.complete) return undefined;
        for (const file of read.files) {
          for (const path of [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]) paths.add(path.replace(/^(?:\.\/|\/)+/u, ""));
          if (paths.size > TOUCHED_PATHS_MAX) return undefined;
        }
        repos.add(pullRequest.repositoryId);
      }
    } catch { return undefined; }
    return { paths: [...paths], repos: [...repos] };
  }

  /** The answer of `work`, or undefined when it fails or `ms` pass (a host that hangs is not waited for: the file list is then "not known"). */
  const within = <T>(work: Promise<T | undefined>, ms: number): Promise<T | undefined> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });

  /**
   * The comments on the ticket that STARTED this task, as spans (see the top of the file). Only a task that ended; only the ticket intake started THIS task from (`originTicketOf` with `strict`); never a paused source; only
   * comments created after the task started and before it ended. A tracker with no `comments`, a ticket with more comments than one read reaches, a read that fails or takes too long: no spans (never a partial answer, never a throw).
   */
  async function ticketComments(task: TaskRecord): Promise<EvidenceSpan[]> {
    const tickets = options.tickets;
    if (tickets === undefined) return [];
    const skip = (code: string): EvidenceSpan[] => { options.log?.("lessons.ticket_comments_skipped", { code }); return []; };
    try {
      if (await tickets.paused(task.project)) return skip("paused");
      const sessionId = (task as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string") return [];
      const origin = await originTicketOf({ store: flow.store, now: options.now }, { orgId: options.companyId, project: task.project, taskId: task.taskId, sessionId }, { strict: true });
      if (origin === undefined) return [];
      const tracker = tickets.trackerFor(origin.tracker);
      if (tracker?.comments === undefined) return skip("no_read");
      const startedAt = Date.parse(task.createdAt);
      const ended = [task.releasedAt, task.closedAt].flatMap((at) => (typeof at === "string" && Number.isFinite(Date.parse(at)) ? [Date.parse(at)] : []));
      const endedAt = Math.min(options.now(), ...ended);
      if (!Number.isFinite(startedAt) || !(endedAt > startedAt)) return [];
      const ref = { tracker: origin.tracker, id: origin.id, ...(origin.url === "" ? {} : { url: origin.url }) } as TrackerItemRef;
      const rows: TicketCommentRow[] = [];
      const progress: { next: number | undefined } = { next: 1 };
      const stop = { done: false };
      await withTimeout((async () => {
        for (let read = 0; progress.next !== undefined && read < TICKET_PAGES_MAX && !stop.done; read += 1) {
          const got = await tracker.comments!(ref, { since: new Date(startedAt).toISOString(), page: progress.next }, tickets.scope);
          for (const comment of got.comments) {
            // A comment the adapter says is on another item is not this ticket's.
            if (comment.subject.kind !== "item" || comment.subject.ref.tracker !== origin.tracker || comment.subject.ref.id.toLowerCase() !== origin.id.toLowerCase()) continue;
            rows.push({ id: comment.id, ...(comment.author.hostUserId === undefined ? {} : { accountId: comment.author.hostUserId }), isBot: comment.author.isBot, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt });
          }
          progress.next = got.nextPage;
        }
      })(), TICKET_READ_MS).finally(() => { stop.done = true; });
      // More comments than one read reaches: not read at all (a partial answer is no answer).
      if (progress.next !== undefined) return skip("too_many");
      const tenant = tenantOf(origin.tracker, origin.url);
      return await ticketCommentSpans({
        tracker: origin.tracker, ticket: origin.id, project: task.project, startedAt, endedAt, rows,
        personOf: (accountId) => tickets.personOfAccount(origin.tracker, tenant, accountId),
        standingOf: (person) => standingOf(person, task.project),
      });
    } catch { return skip("failed"); }
  }

  const source: TaskSubjectSource = {
    async projectOf(input) {
      const task = await readTask(flow, input.taskId);
      return teaches(task, input.workspaceId) ? task.project : undefined;
    },
    async read(input): Promise<TaskSubjectBase | undefined> {
      // Lead 4 L4-LP3Wc: a kind of evidence a person paused is a stop: none of its spans is gathered here (no finding, check text, close reason or pull request comment is read, and the code host is not asked for comments).
      const skip: ReadonlySet<string> = input.skip ?? new Set();
      const task = await readTask(flow, input.taskId);
      if (!teaches(task, input.workspaceId)) return undefined;
      const workspaceId = input.workspaceId;
      const project = task.project;
      const workflow = task.workflow;
      const allRepositories = (await options.repos.ofProject(project).catch(() => [])).map((repository) => repository.name);
      const base = baseOf(task, allRepositories);
      const repositories = base === undefined ? allRepositories : [base.repository];

      const spans: EvidenceSpan[] = [];
      // The person the task is for. An erased one (or one whose record cannot be read: the read throws) teaches nothing.
      const requester = hosted === undefined ? ownerId : task.developerId;
      const requesterTrust = await standingOf(requester, project);
      if (requesterTrust === undefined) return undefined;
      const requestText = (task as { requestText?: string }).requestText;
      const intentText = present(requestText) ? requestText : task.title;
      if (present(intentText)) spans.push({ kind: "intent", text: intentText, trust: requesterTrust, authorId: requester });

      if (workflow !== undefined && options.readObject !== undefined) {
        const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").sort((a, b) => a.version - b.version).at(-1);
        if (plan !== undefined) {
          const loaded = await loadWorkflowDocument((key, max) => options.readObject!(key, max).catch(() => undefined), plan, {}).catch(() => undefined);
          if (present(loaded?.markdown)) spans.push({ kind: "plan", text: loaded.markdown.slice(0, PLAN_MAX_BYTES), trust: AGENT_TEXT_TRUST, sourceKey: "plan" });
        }
      }
      let findings = 0;
      for (const review of skip.has("review_finding") ? [] : workflow?.reviews ?? []) {
        for (const finding of review.findings) {
          if (finding.origin !== "INTRODUCED" || findings >= MAX_FINDINGS) continue;
          findings += 1;
          spans.push({ kind: "review_finding", text: finding.text, trust: AGENT_TEXT_TRUST, sourceKey: `review:${review.role.toLowerCase()}` });
        }
      }
      if (workflow?.fixSource === "ci" && !skip.has("ci_failure")) for (const problem of (workflow.fixProblems ?? []).slice(0, MAX_CI_PROBLEMS)) spans.push({ kind: "ci_failure", text: `${CI_FAILURE_PREFIX}${problem}`, trust: AGENT_TEXT_TRUST, sourceKey: "ci" });
      const closer = skip.has("close_reason") ? undefined : [...(workflow?.decisions ?? [])].reverse().find((decision) => decision.decision === "REJECT" && decision.actorRole === "TASK_OWNER");
      const closerId = closer === undefined ? undefined : deciderOf(closer);
      const closerTrust = closerId === undefined ? undefined : await standingOf(closerId, project);
      if (closer !== undefined && closerId !== undefined && closerTrust !== undefined) spans.push({ kind: "close_reason", text: closer.reason, trust: closerTrust, authorId: closerId });

      // A person's own words when they asked for changes at a plan or design approval step (the gate's REQUEST_CHANGES decision and its `reason`): a learning subject beside the send-backs, of its own span kind so a send-back's
      // credit (a send-back is counted once, and measured) and the repeat metric are not changed by it. The decider's standing is read NOW, as for a send-back: an erased person's words are skipped, and a person off the project's
      // roster is not a member (their words are not carried at all). Rovara's own decisions (the AGENTX actor, an automatic source) and a send-back or findings answer (read as send-backs) are not these.
      spans.push(...(await planComments(task, workflow)));

      if (input.context !== "human_edit" && !skip.has("pr_comment")) {
        let taken = 0;
        for (const pullRequest of (workflow?.pullRequests ?? []).slice(0, MAX_PULL_REQUESTS)) {
          if (taken >= MAX_PULL_REQUEST_COMMENTS) break;
          const repo = await options.repos.ofTask(project, task.startingRevision, pullRequest.repositoryId);
          if (repo === undefined) continue;
          const read = await reviewComments(task, pullRequest, repo);
          taken += read.length;
          spans.push(...read);
        }
      }

      // L4-SRC-TK: only a task that ENDED teaches from its ticket's comments (a send-back reflection of an open task reads none), and never for the human-edit job.
      if (input.context !== "human_edit" && outcomeOf(workflow) !== undefined) spans.push(...(await ticketComments(task)));

      const outcome = outcomeOf(workflow);
      const links = (workflow?.pullRequests ?? []).map((pullRequest) => pullRequest.url).slice(0, 32);
      const sendBackRequestIds = skip.has("send_back") ? [] : (workflow?.decisions ?? []).filter(isHumanSendBack).map((decision) => decision.requestId).slice(0, MAX_SEND_BACK_IDS);
      let mergedCommit: string | undefined;
      if (outcome === "merged" && base !== undefined) {
        const merged = (workflow?.pullRequests ?? []).find((pullRequest) => pullRequest.repositoryId === base.repository && pullRequest.state === "MERGED");
        mergedCommit = merged?.headSha;
      }
      // The merged change's own file list, for the credit of a clean merge (not for a human edit's read, and not for a task that did not merge).
      const touched = outcome === "merged" && input.context !== "human_edit" ? await within(touchedByMerge(task, workflow), TOUCHED_READ_MS) : undefined;
      return {
        facts: {
          workspaceId, project, taskId: task.taskId, repositories,
          ...(base === undefined ? {} : { baseCommit: base.commit }), ...(mergedCommit === undefined ? {} : { mergedCommit }), ...(outcome === undefined ? {} : { outcome }),
          // The task's person started it (on a laptop, the owner). (An automatic run has no start fields, and nobody is named for it.)
          task: { developerId: requester, startedBy: { developerId: requester } },
          rest: {
            initiatorTrust: requesterTrust, steeringTrust: [requesterTrust], intentTrust: requesterTrust, ...(links.length === 0 ? {} : { links }),
            // The owner is the one reader of this machine's tasks, and they are open to the whole project.
            audience: { kind: "project" }, sharedTask: true, spans,
          },
        },
        sendBackRequestIds, ...(touched === undefined ? {} : { touchedPaths: touched.paths, touchedRepos: touched.repos }),
        // When the task was alive: a kind stopped at any time during it is not read after a resume (`lessons/paused-kinds.ts`).
        ...(lifetimeOf(task) === undefined ? {} : { lifetime: lifetimeOf(task)! }),
      };
    },
  };

  const rows: OutcomeRowReader = {
    async sendBack(input) {
      const task = await readTask(flow, input.taskId);
      if (!teaches(task, input.workspaceId)) return undefined;
      const decision = (task.workflow?.decisions ?? []).find((entry) => entry.requestId === input.requestId);
      if (decision === undefined) return undefined;
      const human = isHumanSendBack(decision);
      if (!human) return { id: `task:${input.taskId}:sendback:${input.requestId}`, origin: "automatic" };
      // A send-back is its decider's: an erased decider's send-back is not a measured outcome, and their reason is not read.
      const actor = deciderOf(decision);
      const actorTrust = actor === undefined ? undefined : await standingOf(actor, task.project);
      if (actor === undefined || actorTrust === undefined) return undefined;
      const id = `task:${input.taskId}:sendback:${input.requestId}`;
      // A findings answer's reason is code's own summary ("N accepted, M to fix"), never the person's words. Their words are the per-finding notes kept beside the workflow (owner note); with none, the send-back is counted
      // and its text is code's fixed text. (Read only for a task of this company, checked above.)
      if (decision.source === "FINDINGS") {
        const notes = await readOwnerFindingNotes(flow.store, task.taskId, input.requestId);
        const fact: SendBackFact = notes.length === 0
          ? { id, origin: "human", actorDeveloperId: actor, actorTrust, fixedText: true }
          : { id, origin: "human", actorDeveloperId: actor, actorTrust, reasonText: notes.join("\n").slice(0, FINDING_NOTES_TEXT_MAX) };
        return fact;
      }
      const fact: SendBackFact = { id, origin: "human", actorDeveloperId: actor, actorTrust, reasonText: decision.reason };
      return fact;
    },
    async revertedBy(input) {
      // The revert detector records a row only for a person with write access to the repository; the row is the task's own.
      const found = await queryAll(flow.store, { pk: `DEVTASK#${input.taskId}`, sk: { op: "beginsWith", prefix: "REVERT#" } });
      const row = found.find((item) => item["entityType"] === "TASK_REVERT" && item["taskId"] === input.taskId && item["project"] === input.project);
      if (row === undefined) return undefined;
      // On a hosted install a reverter's account is not proved to be any person here, so no one is named (the revert still counts as an outcome).
      if (hosted !== undefined) return {};
      return typeof row["reverter"] === "string" && row["reverter"] !== "" ? { actorDeveloperId: ownerId === row["reverter"] ? ownerId : accountPerson("host", { login: row["reverter"] }) } : {};
    },
  };

  // The revert detector writes one row per reverted task under the task's own partition; there is no project-wide index, so the nightly pass over reverts is the detector's own hook (`noteReverted`), not a scan.
  const reverts: RevertedTasksReader = { async since() { return { taskIds: [], truncated: false }; } };
  return { source, rows, reverts };
}
