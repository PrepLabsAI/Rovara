// Lane L12, slice 2: pull request comment commands on a laptop. A laptop has no webhook, so `rovara up` POLLS the conversations of the pull requests it tracks (and of any thread the owner attached to a
// task) through the code-host port's `comments` read, and feeds each new comment to the core's `createPrCommentCommands` (`/rovara approve <version>`, `/rovara changes: ...`, `/rovara stop`, `/rovara lesson ...`).
//
// OWNER DECISION 66: the code host only FETCHES a comment: its text, author, times, the change request it is on, and (through `standing`) its author's permission. Every safety check is Rovara's:
//   - `core/pr-commands/handler.ts`: only a freshly written comment, never an edited one, a bot's or Rovara's own, on the thread the poll named, from someone who may write, used once;
//   - `core/pr-commands/comment-checks.ts`: asked again by the Approvers seam when the decision is made, from a second read of the comment: on THIS request's change request, written after the version
//     being decided was posted, never edited, the right command for the answer, and an approval that NAMES the version it approves.
//
// What a task's threads are: the thread the owner attached to the task from its page (a plan posted on an issue or pull request), and each of the task's open pull requests. ONE OPEN TASK PER THREAD: a comment names
// no task, so a thread two tasks share decides nothing (review H1). The thread a decision waits on is the attached one, else the task's first pull request.
import { randomUUID } from "node:crypto";
import { providerOf } from "../../plugins/routing.js";
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, hostRateLimitRetryAt, queryAll, when,
  type ApprovalRequest, type CodeHost, type HostComment, type OrgId, type Principal, type RegistryView, type StoredDocument,
} from "@agentx/contracts";
import { currentDocumentType } from "../../core/decisions/workflow-subject.js";
import type { createDecisionActions } from "../../core/decisions/local-actions.js";
import { changeRequestRef } from "../../core/merge/host-port.js";
import { shortDigest, type CommentRequestContext, type FetchedComment } from "../../core/pr-commands/comment-checks.js";
import { createPrCommentCommands, type LookedUpComment, type PendingOffer, type PrCommentEvent, type PrCommandWorld } from "../../core/pr-commands/handler.js";
import { codeHostRepositoryKey } from "../../core/proof/revert/repository-key.js";
import { createLocalSessionControl } from "./host.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { listTasks, readTask } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";
import { approvalOfferOf } from "./page-data.js";
import type { LocalLessons } from "./lessons.js";
import { createReadBudget, createRepositoryResolver } from "./tracking.js";

/** The comment poll of one pass: threads, requests and time. */
const POLL_MAX_THREADS = 20;
const POLL_MAX_REQUESTS = 96;
const POLL_MAX_MS = 15_000;
/** A thread's conversation is read at most this many pages (of 100) to find one comment by id, and in one poll. */
const FIND_PAGES_MAX = 5;
const POLL_PAGES_MAX = 10;
const THREADS_PK = "COMMENT_THREADS";
const CURSORS_PK = "COMMENT_CURSOR";
const NOTICES_PK = "COMMENT_NOTICE";
/** A thread whose read fails waits this many poll intervals for each failure, up to this long. */
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
/** A cursor is kept this long after the last poll of its thread. */
const CURSOR_KEEP_SECONDS = 30 * 86_400;

export interface LocalCommentsOptions {
  flow: TaskFlowDeps;
  registry: RegistryView;
  companyId: OrgId;
  owner: Principal;
  decisions: ReturnType<typeof createDecisionActions>;
  /** `/rovara lesson <n> wrong|right|retire`: answered by the lessons of this install. Absent: the command answers that there are no lessons. */
  lessons?: Pick<LocalLessons, "command"> | undefined;
  now: () => number;
  /** Told when a code host asks Rovara to slow down (the same pause merge tracking keeps). */
  pauseUntil?: (retryAt: number) => void;
  paused?: () => number | undefined;
  pollMs?: number;
  /** The most threads one poll reads (default 20); the rest are read in turn by the polls that follow. */
  threadsPerPoll?: number;
  log?: (entry: Record<string, unknown>) => void;
}

/** A conversation Rovara reads: the change request (or issue), the task it belongs to and where it is on the code host. */
interface Thread {
  taskId: string;
  repositoryId: string;
  repositoryKey: string;
  number: number;
  url: string;
  host: CodeHost;
  /** When the thread began being Rovara's (the pull request opened, or the owner attached it): comments before it answer nothing. */
  since: string;
  attached: boolean;
}

export interface LocalComments {
  /** The Approvers seam's two reads (fetch only): the comment by id, and where the request was posted. */
  fetchComment(commentId: string, request: ApprovalRequest): Promise<FetchedComment | undefined>;
  contextOf(request: ApprovalRequest): Promise<CommentRequestContext | undefined>;
  /** Whether any registered code host can read comments (the `code-host-comment` way of approving is offered only then). */
  available(): boolean;
  /** The owner says a task's plan is posted on this issue or pull request of one of its project's repositories. Refused for a thread another open task already has. */
  attachThread(taskId: string, input: { repository: string; number: number }): Promise<void>;
  /** The thread the owner attached to the task, if any. */
  attachedThread(taskId: string): Promise<{ repository: string; number: number } | undefined>;
  /** One poll: posts the notices of the versions that wait, reads the new comments of every thread (rotating when there are more than a poll can read), and runs the commands in them. Never throws. */
  poll(): Promise<{ threads: number; comments: number; handled: number; notices: number }>;
}

const jsonOf = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;

export function createLocalComments(options: LocalCommentsOptions): LocalComments {
  const { flow, registry, companyId, now } = options;
  const store = flow.store;
  const log = options.log ?? (() => undefined);
  const resolver = createRepositoryResolver(flow, registry);
  const scope = { orgId: companyId };
  const sessionControl = createLocalSessionControl(flow);
  const iso = (): string => new Date(now()).toISOString();

  // ---- threads

  const threadRowKey = (taskId: string) => ({ pk: THREADS_PK, sk: `TASK#${taskId}` });

  /** The thread of one repository and number of a task, resolved on the code host its repository names. */
  const threadAt = async (task: TaskRecord, repositoryId: string, number: number, attachedRow: StoredDocument | undefined): Promise<Thread | undefined> => {
    const home = await resolver(task.project, task.startingRevision, repositoryId, companyId).catch(() => undefined);
    if (home === undefined) return undefined;
    const repositoryKey = codeHostRepositoryKey(providerOf(home.codeHost), home.url);
    if (repositoryKey === undefined) return undefined;
    const pullRequest = (task.workflow?.pullRequests ?? []).find((entry) => entry.repositoryId === repositoryId && entry.number === number);
    const since = typeof attachedRow?.["attachedAt"] === "string" ? attachedRow["attachedAt"] : pullRequest?.observedAt ?? task.updatedAt;
    return { taskId: task.taskId, repositoryId, repositoryKey, number, url: home.url, host: home.codeHost, since, attached: attachedRow !== undefined };
  };

  /** Every thread of a task: the one the owner attached, then each of its pull requests that is not merged. Both are read (an attached thread never hides the pull request). */
  const threadsOfTask = async (task: TaskRecord): Promise<Thread[]> => {
    const workflow = task.workflow;
    if (workflow === undefined || task.closedAt !== undefined) return [];
    const attached = await store.get(threadRowKey(task.taskId));
    const found: Thread[] = [];
    if (typeof attached?.["repositoryId"] === "string" && typeof attached["number"] === "number") {
      const thread = await threadAt(task, attached["repositoryId"], attached["number"], attached);
      if (thread !== undefined) found.push(thread);
    }
    for (const pullRequest of (workflow.pullRequests ?? []).filter((entry) => entry.state !== "MERGED")) {
      if (found.some((thread) => thread.repositoryId === pullRequest.repositoryId && thread.number === pullRequest.number)) continue;
      const thread = await threadAt(task, pullRequest.repositoryId, pullRequest.number, undefined);
      if (thread !== undefined) found.push(thread);
    }
    return found;
  };

  /** The thread a decision on the task waits on: the attached one, else its first pull request. */
  const decisionThreadOf = async (task: TaskRecord): Promise<Thread | undefined> => (await threadsOfTask(task))[0];

  /** Every open task's threads, from the owner's task list. */
  const allThreads = async (): Promise<Thread[]> => {
    const found: Thread[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const listed = await listTasks(flow, { principal: options.owner }, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const row of listed.tasks) {
        const task = await readTask(flow, row.taskId);
        if (task === undefined || task.companyId !== companyId) continue;
        found.push(...await threadsOfTask(task));
      }
      cursor = listed.cursor;
      if (cursor === undefined) break;
    }
    return found;
  };

  /** The thread list of the poll that is running, so a command comment does not read every task again (review L10). */
  let cachedThreads: Thread[] | undefined;
  const threadsNow = async (): Promise<Thread[]> => cachedThreads ?? allThreads();
  const sameThread = (thread: { repositoryKey: string; number: number }, change: { repository: string; number: number }): boolean => thread.repositoryKey.toLowerCase() === change.repository.toLowerCase() && thread.number === change.number;
  const threadsFor = async (change: { repository: string; number: number }): Promise<Thread[]> => (await threadsNow()).filter((thread) => sameThread(thread, change));
  /** The tasks that work on a change request. More than one: a comment cannot say which it means. */
  const tasksAt = async (change: { repository: string; number: number }): Promise<string[]> => [...new Set((await threadsFor(change)).map((thread) => thread.taskId))];

  // ---- reading comments (fetch only)

  /** The comment by id on a thread's conversation, from the host. The first pages of the conversation are read until it is found. */
  const findComment = async (thread: Thread, commentId: string, budget?: ReturnType<typeof createReadBudget>["budget"]): Promise<HostComment | undefined> => {
    const host = thread.host;
    if (host.comments === undefined) return undefined;
    for (let page = 1; page <= FIND_PAGES_MAX; page += 1) {
      const answered = await host.comments(changeRequestRef(thread.url, thread.number), { page }, scope, budget);
      const found = answered.comments.find((entry) => entry.id === commentId);
      if (found !== undefined) return found;
      if (answered.nextPage === undefined) return undefined;
    }
    return undefined;
  };

  /** Where the host says the comment is. The core compares it with the request's thread. */
  const onOf = (thread: Thread, comment: HostComment): { repository: string; number: number } => {
    const key = codeHostRepositoryKey(providerOf(thread.host), comment.ref.repository.url);
    return { repository: key ?? "", number: Number(comment.ref.id) };
  };

  const standingOf = async (thread: Thread, login: string, budget?: ReturnType<typeof createReadBudget>["budget"]): Promise<"none" | "read" | "write" | "admin"> =>
    (await thread.host.standing({ url: thread.url }, { login }, scope, budget)).permission;

  /** An account by the host's own id when it gives one (a login can be renamed), else by login. */
  const accountOf = (thread: Thread, comment: HostComment) => ({ provider: thread.host.kind, tenant: "", accountId: comment.author.hostUserId ?? comment.author.login });

  const taskOfRequest = async (request: ApprovalRequest): Promise<TaskRecord | undefined> => {
    if (request.subject.type !== "task") return undefined;
    const task = await readTask(flow, request.subject.id);
    return task !== undefined && task.companyId === companyId ? task : undefined;
  };

  const fetchComment = async (commentId: string, request: ApprovalRequest): Promise<FetchedComment | undefined> => {
    const task = await taskOfRequest(request);
    if (task === undefined) return undefined;
    // The comment is looked for on every thread of the task; the core then checks it is on the thread this request waits on.
    for (const thread of await threadsOfTask(task)) {
      const comment = await findComment(thread, commentId);
      if (comment === undefined) continue;
      return {
        author: accountOf(thread, comment), authorIsBot: comment.author.isBot, permission: await standingOf(thread, comment.author.login), body: comment.body,
        createdAt: comment.createdAt, updatedAt: comment.updatedAt, on: onOf(thread, comment),
      };
    }
    return undefined;
  };

  const contextOf = async (request: ApprovalRequest): Promise<CommentRequestContext | undefined> => {
    const task = await taskOfRequest(request);
    const workflow = task?.workflow;
    if (task === undefined || workflow === undefined) return undefined;
    const thread = await decisionThreadOf(task);
    if (thread === undefined) return undefined;
    // The version being decided was posted when its document was saved; a thread the owner attached later only begins then.
    const posted = workflow.artifacts.filter((artifact) => artifact.type === currentDocumentType(workflow)).at(-1)?.createdAt;
    if (posted === undefined) return undefined;
    const later = thread.attached ? Math.max(Date.parse(posted), Date.parse(thread.since)) : Date.parse(posted);
    return { repository: thread.repositoryKey, number: thread.number, postedAt: new Date(later).toISOString() };
  };

  // ---- the task flow's side of the commands

  const world: PrCommandWorld = {
    async pendingFor(change): Promise<PendingOffer | undefined | "several"> {
      const tasks = await tasksAt(change);
      // A comment names no task: with more than one here it decides none of them.
      if (tasks.length > 1) return "several";
      for (const taskId of tasks) {
        const task = await readTask(flow, taskId);
        const workflow = task?.workflow;
        if (task === undefined || workflow === undefined) continue;
        const approval = approvalOfferOf(task.taskId, workflow);
        const context = approval === undefined ? undefined : await contextOf({ companyId, requestId: approval.requestId, kind: approval.kind, subject: { type: "task", id: task.taskId }, revision: approval.revision, artifactDigest: approval.artifactDigest });
        // The decision waits on one thread; a comment anywhere else is not an answer to it.
        if (approval !== undefined && context !== undefined && sameThread({ repositoryKey: context.repository, number: context.number }, change)) return { taskId: task.taskId, approval, postedAt: context.postedAt, repository: context.repository };
      }
      return undefined;
    },
    decide: (input) => options.decisions.decideFromComment(input),
    async lesson(input) {
      // The number names a lesson in the "Lessons used" list of the pull request the comment is on, which belongs to one task; a change several tasks share decides none.
      const tasks = await tasksAt({ repository: input.repository, number: input.number });
      if (tasks.length > 1) return { ok: false, reason: "refused", message: "Several tasks work on this change, so I cannot tell which one used that lesson." };
      if (tasks[0] === undefined || options.lessons === undefined) return { ok: false, reason: "not_found", message: "No lessons are recorded for this change." };
      return options.lessons.command({ ...input, taskId: tasks[0] });
    },
    async stop(change) {
      const tasks = await tasksAt(change);
      if (tasks.length > 1) return { ok: false, reason: "refused", message: "Several tasks work on this change, so I cannot tell which to stop. Stop the one you mean on its page." };
      const task = tasks[0] === undefined ? undefined : await readTask(flow, tasks[0]);
      if (task === undefined || task.sessionId === undefined) return { ok: false, reason: "not_found", message: "Nothing is running for this change." };
      const stopped = await sessionControl.stop(options.owner, companyId, task.sessionId, { requestId: randomUUID() });
      return "status" in stopped && stopped.status === "refused" ? { ok: false, reason: "refused", message: "That could not be stopped." } : { ok: true, message: "Stopped the work on this change." };
    },
  };

  /** The comments one poll has read, so the handler's lookup by id does not read the conversation again. */
  const seen = new Map<string, { thread: Thread; comment: HostComment }>();
  let pollBudget: ReturnType<typeof createReadBudget>["budget"] | undefined;

  const commands = createPrCommentCommands({
    store, world, now: () => new Date(now()),
    host: {
      async lookupComment(ref): Promise<LookedUpComment | undefined> {
        const known = seen.get(ref.commentId);
        const thread = known?.thread ?? (await threadsFor(ref))[0];
        if (thread === undefined) return undefined;
        const comment = known?.comment ?? await findComment(thread, ref.commentId, pollBudget);
        if (comment === undefined) return undefined;
        // The author's standing is asked only about a comment that is a command: the rest are dropped before it matters.
        const command = /^\s*\/rovara\b/u.test(comment.body);
        return {
          body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt, author: accountOf(thread, comment),
          authorPermission: command && !comment.author.isBot ? await standingOf(thread, comment.author.login, pollBudget) : "none", authorIsBot: comment.author.isBot, on: onOf(thread, comment),
        };
      },
      async reply(event, text): Promise<void> {
        const [thread] = await threadsFor(event);
        if (thread?.host.postComment === undefined) return;
        await thread.host.postComment(changeRequestRef(thread.url, thread.number), text, scope, pollBudget);
      },
    },
  });

  // ---- the poll

  let lastPoll: number | undefined;
  const pollMs = options.pollMs ?? 60_000;

  const cursorKey = (thread: Thread) => ({ pk: CURSORS_PK, sk: `${thread.repositoryKey}#${String(thread.number)}` });

  /** The notice of a version that waits on an attached thread: which version, and the words that approve exactly it. Once for each version. */
  const postNotices = async (threads: readonly Thread[]): Promise<number> => {
    let posted = 0;
    for (const thread of threads.filter((entry) => entry.attached && entry.host.postComment !== undefined)) {
      const task = await readTask(flow, thread.taskId);
      const workflow = task?.workflow;
      const offer = task === undefined || workflow === undefined ? undefined : approvalOfferOf(task.taskId, workflow);
      if (offer === undefined) continue;
      // The claim is for this version ON THIS thread: a thread the owner moved the plan to gets its own notice (N6).
      const key = { pk: NOTICES_PK, sk: `${thread.taskId}#${offer.artifactDigest}#${thread.repositoryKey}#${String(thread.number)}` };
      const claimed = await store.put({ item: jsonOf({ ...key, entityType: "COMMENT_NOTICE", taskId: thread.taskId, repositoryKey: thread.repositoryKey, number: thread.number, at: iso(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + CURSOR_KEEP_SECONDS }), condition: when.absent() });
      if (!claimed.applied) continue;
      const short = shortDigest(offer.artifactDigest);
      try {
        await thread.host.postComment!(changeRequestRef(thread.url, thread.number), `Plan version ${short} is waiting for a decision. To approve it, say /rovara approve ${short}. To ask for changes, say /rovara changes: and what to change.`, scope, pollBudget);
        posted += 1;
      } catch (error) {
        // Not posted: give the claim back so the next poll tries again (a rate limit is also the pause's to know).
        await store.delete({ key }).catch(() => undefined);
        const limitedUntil = hostRateLimitRetryAt(error);
        if (limitedUntil !== undefined) { options.pauseUntil?.(limitedUntil); break; }
        log({ component: "pr_comments", event: "notice.failed", error: error instanceof Error ? error.name : "unknown" });
      }
    }
    return posted;
  };

  return {
    fetchComment, contextOf,
    available: () => registry.names("code-host").some((kind) => registry.get("code-host", kind)?.comments !== undefined),

    async attachedThread(taskId) {
      const row = await store.get(threadRowKey(taskId));
      return typeof row?.["repositoryId"] === "string" && typeof row["number"] === "number" ? { repository: row["repositoryId"], number: row["number"] } : undefined;
    },

    async attachThread(taskId, input) {
      const task = await readTask(flow, taskId);
      if (task === undefined || task.companyId !== companyId || task.closedAt !== undefined) throw agentXError("NOT_FOUND", "There is no open task with that id.");
      // Only a repository of the task's own project: a comment from a writer elsewhere must never decide this task.
      const project = await flow.projects.revision(task.project, task.startingRevision);
      const definition = project?.definition.repositories.find((entry) => entry.name === input.repository);
      if (definition === undefined || !Number.isSafeInteger(input.number) || input.number < 1) throw agentXError("CONFIG_INVALID", "name a repository of the task's project and an issue or pull request number");
      // ONE open task for a thread: a comment names no task, so a thread two tasks share would let one task's comment decide the other.
      const wanted = await threadAt(task, input.repository, input.number, undefined);
      if (wanted !== undefined && (await allThreads()).some((thread) => thread.taskId !== taskId && sameThread(thread, { repository: wanted.repositoryKey, number: wanted.number }))) {
        throw agentXError("CONFIG_INVALID", "Another open task already works on that issue or pull request. A comment there could not say which task it means.");
      }
      await store.put({ item: jsonOf({ ...threadRowKey(taskId), entityType: "COMMENT_THREAD", taskId, repositoryId: input.repository, number: input.number, attachedAt: iso(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + CURSOR_KEEP_SECONDS }) });
    },

    async poll() {
      const result = { threads: 0, comments: 0, handled: 0, notices: 0 };
      const at = now();
      const pausedUntil = options.paused?.();
      if (pausedUntil !== undefined || (lastPoll !== undefined && at - lastPoll < pollMs)) return result;
      lastPoll = at;
      const { budget, stop } = createReadBudget(now, { requests: POLL_MAX_REQUESTS, ms: POLL_MAX_MS });
      pollBudget = budget;
      try {
        cachedThreads = (await allThreads()).filter((thread) => thread.host.comments !== undefined);
        result.notices = await postNotices(cachedThreads);
        const unique = new Map<string, Thread>();
        for (const thread of cachedThreads) unique.set(`${thread.repositoryKey}#${String(thread.number)}`, thread);
        // Round-robin: the threads read longest ago go first, so with more threads than one poll can read every thread is reached in turn.
        const cursors = new Map((await queryAll(store, { pk: CURSORS_PK })).map((row) => [String(row["sk"]), row]));
        const ordered = [...unique.values()].sort((left, right) => Number(cursors.get(`${left.repositoryKey}#${String(left.number)}`)?.["polledAt"] ?? 0) - Number(cursors.get(`${right.repositoryKey}#${String(right.number)}`)?.["polledAt"] ?? 0));
        const due = ordered.filter((thread) => Number(cursors.get(`${thread.repositoryKey}#${String(thread.number)}`)?.["retryAfter"] ?? 0) <= at);
        for (const thread of due.slice(0, options.threadsPerPoll ?? POLL_MAX_THREADS)) {
          if (budget.signal.aborted) break;
          result.threads += 1;
          const cursor = cursors.get(`${thread.repositoryKey}#${String(thread.number)}`);
          const since = typeof cursor?.["since"] === "string" ? cursor["since"] : thread.since;
          let newest = Date.parse(since);
          let finished = false;
          try {
            let page: number | undefined = 1;
            for (let read = 0; page !== undefined && read < POLL_PAGES_MAX; read += 1) {
              const answered = await thread.host.comments!(changeRequestRef(thread.url, thread.number), { since, page }, scope, budget);
              for (const comment of answered.comments) {
                result.comments += 1;
                seen.set(comment.id, { thread, comment });
                const event: PrCommentEvent = { companyId, action: "created", repository: thread.repositoryKey, number: thread.number, commentId: comment.id };
                if ((await commands.handle(event)).handled) result.handled += 1;
                newest = Math.max(newest, Date.parse(comment.updatedAt));
              }
              page = answered.nextPage;
            }
            finished = page === undefined;
          } catch (error) {
            const limitedUntil = hostRateLimitRetryAt(error);
            if (limitedUntil !== undefined) { options.pauseUntil?.(limitedUntil); break; }
            // A comment whose command failed is given back (the handler removes its claim) and is read again by the next poll: the cursor stays before it. But the thread is marked as read now, and waits
            // longer after each failure, so a thread that always fails goes to the back of the line and cannot starve the others (N5).
            log({ component: "pr_comments", event: "poll.thread_failed", error: error instanceof Error ? error.name : "unknown" });
            const failures = Number(cursor?.["failures"] ?? 0) + 1;
            await store.put({ item: jsonOf({ ...cursorKey(thread), entityType: "COMMENT_CURSOR", since, polledAt: at, failures, retryAfter: at + Math.min(failures * pollMs, FAILURE_BACKOFF_MAX_MS), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + CURSOR_KEEP_SECONDS }) }).catch(() => undefined);
            continue;
          } finally {
            seen.clear();
          }
          // The cursor moves only when the whole conversation since it was read: with more comments than a poll reads, the next poll starts where this one did (claims keep a comment from running twice).
          await store.put({ item: jsonOf({ ...cursorKey(thread), entityType: "COMMENT_CURSOR", since: new Date(finished ? newest : Date.parse(since)).toISOString(), polledAt: at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + CURSOR_KEEP_SECONDS }) }).catch(() => undefined);
        }
      } catch (error) {
        const limitedUntil = hostRateLimitRetryAt(error);
        if (limitedUntil !== undefined) options.pauseUntil?.(limitedUntil);
        else log({ component: "pr_comments", event: "poll.failed", error: error instanceof Error ? error.name : "unknown" });
      } finally {
        stop();
        pollBudget = undefined;
        cachedThreads = undefined;
      }
      return result;
    },
  };
}
