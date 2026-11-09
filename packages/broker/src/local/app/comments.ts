// Lane L12, slice 2: pull request comment commands on a laptop. A laptop has no webhook, so `rovara up` POLLS the conversations of the pull requests it tracks (and of any thread the owner attached to a
// task) through the code-host port's `comments` read, and feeds each new comment to the core's `createPrCommentCommands` (`/rovara approve`, `/rovara changes: ...`, `/rovara stop`, `/rovara lesson ...`).
//
// OWNER DECISION 66: the code host only FETCHES a comment: its text, author, times, the change request it is on, and (through `standing`) its author's permission. Every safety check is Rovara's:
//   - `core/pr-commands/handler.ts`: only a freshly written comment, never an edited one, a bot's or Rovara's own, on the thread the poll named, from someone who may write, used once;
//   - `core/pr-commands/comment-checks.ts`: asked again by the Approvers seam when the decision is made, from a second read of the comment: on THIS request's change request, written after the version
//     being decided was posted, never edited, the right command for the answer.
//
// What a request's thread is: the thread the owner attached to the task (a plan posted on an issue or pull request), else the task's pull request. A task has one.
import { randomUUID } from "node:crypto";
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, hostRateLimitRetryAt,
  type ApprovalRequest, type CodeHost, type HostComment, type OrgId, type Principal, type RegistryView, type StoredDocument,
} from "@agentx/contracts";
import { currentDocumentType } from "../../core/decisions/workflow-subject.js";
import type { createDecisionActions } from "../../core/decisions/local-actions.js";
import { changeRequestRef } from "../../core/merge/host-port.js";
import type { CommentRequestContext, FetchedComment } from "../../core/pr-commands/comment-checks.js";
import { createPrCommentCommands, type LookedUpComment, type PendingOffer, type PrCommentEvent, type PrCommandOutcome, type PrCommandWorld } from "../../core/pr-commands/handler.js";
import { codeHostRepositoryKey } from "../../core/proof/revert/repository-key.js";
import { createLocalSessionControl } from "./host.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { listTasks, readTask } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";
import { approvalOfferOf } from "./page-data.js";
import { createReadBudget, createRepositoryResolver } from "./tracking.js";

/** The comment poll of one pass: threads, requests and time. */
const POLL_MAX_THREADS = 20;
const POLL_MAX_REQUESTS = 96;
const POLL_MAX_MS = 15_000;
/** A thread's conversation is read at most this many pages (of 100) to find one comment by id. */
const FIND_PAGES_MAX = 5;
const POLL_PAGES_MAX = 3;
const THREADS_PK = "COMMENT_THREADS";
const CURSORS_PK = "COMMENT_CURSOR";
/** A cursor is kept this long after the last poll of its thread. */
const CURSOR_KEEP_SECONDS = 30 * 86_400;

export interface LocalCommentsOptions {
  flow: TaskFlowDeps;
  registry: RegistryView;
  companyId: OrgId;
  owner: Principal;
  decisions: ReturnType<typeof createDecisionActions>;
  now: () => number;
  /** Told when a code host asks Rovara to slow down (the same pause merge tracking keeps). */
  pauseUntil?: (retryAt: number) => void;
  paused?: () => number | undefined;
  pollMs?: number;
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
  /** The owner says a task's plan is posted on this issue or pull request of one of its project's repositories. */
  attachThread(taskId: string, input: { repository: string; number: number }): Promise<void>;
  /** One poll: reads the new comments of every thread, once, and runs the commands in them. Never throws. */
  poll(): Promise<{ threads: number; comments: number; handled: number }>;
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

  const threadOf = async (task: TaskRecord): Promise<Thread | undefined> => {
    const workflow = task.workflow;
    if (workflow === undefined || task.closedAt !== undefined) return undefined;
    const attached = await store.get(threadRowKey(task.taskId));
    const repositoryId = typeof attached?.["repositoryId"] === "string" ? attached["repositoryId"] : (workflow.pullRequests ?? []).find((entry) => entry.state !== "MERGED")?.repositoryId;
    const number = typeof attached?.["number"] === "number" ? attached["number"] : (workflow.pullRequests ?? []).find((entry) => entry.state !== "MERGED" && entry.repositoryId === repositoryId)?.number;
    if (repositoryId === undefined || number === undefined) return undefined;
    const home = await resolver(task.project, task.startingRevision, repositoryId, companyId).catch(() => undefined);
    if (home === undefined) return undefined;
    const repositoryKey = codeHostRepositoryKey(home.codeHost.kind, home.url);
    if (repositoryKey === undefined) return undefined;
    const pullRequest = (workflow.pullRequests ?? []).find((entry) => entry.repositoryId === repositoryId && entry.number === number);
    const since = typeof attached?.["attachedAt"] === "string" ? attached["attachedAt"] : pullRequest?.observedAt ?? task.updatedAt;
    return { taskId: task.taskId, repositoryId, repositoryKey, number, url: home.url, host: home.codeHost, since, attached: attached !== undefined };
  };

  /** Every open task's thread, from the owner's task list. */
  const allThreads = async (): Promise<Thread[]> => {
    const found: Thread[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const listed = await listTasks(flow, { principal: options.owner }, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const row of listed.tasks) {
        const task = await readTask(flow, row.taskId);
        if (task === undefined || task.companyId !== companyId) continue;
        const thread = await threadOf(task);
        if (thread !== undefined) found.push(thread);
      }
      cursor = listed.cursor;
      if (cursor === undefined) break;
    }
    return found;
  };

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

  const onOf = (thread: Thread, comment: HostComment): { repository: string; number: number } => {
    const key = codeHostRepositoryKey(thread.host.kind, comment.ref.repository.url);
    // A comment that names a repository the host cannot key is on no thread of ours.
    return { repository: key ?? "", number: Number(comment.ref.id) };
  };

  const standingOf = async (thread: Thread, login: string, budget?: ReturnType<typeof createReadBudget>["budget"]): Promise<"none" | "read" | "write" | "admin"> =>
    (await thread.host.standing({ url: thread.url }, { login }, scope, budget)).permission;

  const threadOfRequest = async (request: ApprovalRequest): Promise<{ thread: Thread; task: TaskRecord } | undefined> => {
    if (request.subject.type !== "task") return undefined;
    const task = await readTask(flow, request.subject.id);
    if (task === undefined || task.companyId !== companyId) return undefined;
    const thread = await threadOf(task);
    return thread === undefined ? undefined : { thread, task };
  };

  const fetchComment = async (commentId: string, request: ApprovalRequest): Promise<FetchedComment | undefined> => {
    const found = await threadOfRequest(request);
    if (found === undefined) return undefined;
    const comment = await findComment(found.thread, commentId);
    if (comment === undefined) return undefined;
    return {
      author: { provider: found.thread.host.kind, tenant: "", accountId: comment.author.login }, authorIsBot: comment.author.accountType === "Bot" || comment.author.login.endsWith("[bot]"),
      permission: await standingOf(found.thread, comment.author.login), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt, on: onOf(found.thread, comment),
    };
  };

  const contextOf = async (request: ApprovalRequest): Promise<CommentRequestContext | undefined> => {
    const found = await threadOfRequest(request);
    const workflow = found?.task.workflow;
    if (found === undefined || workflow === undefined) return undefined;
    // The version being decided was posted when its document was saved; a thread the owner attached later only begins then.
    const posted = workflow.artifacts.filter((artifact) => artifact.type === currentDocumentType(workflow)).at(-1)?.createdAt;
    if (posted === undefined) return undefined;
    const later = found.thread.attached ? Math.max(Date.parse(posted), Date.parse(found.thread.since)) : Date.parse(posted);
    return { repository: found.thread.repositoryKey, number: found.thread.number, postedAt: new Date(later).toISOString() };
  };

  // ---- the task flow's side of the commands

  const threadsFor = async (change: { repository: string; number: number }): Promise<Thread[]> =>
    (await allThreads()).filter((thread) => thread.repositoryKey.toLowerCase() === change.repository.toLowerCase() && thread.number === change.number);

  const world: PrCommandWorld = {
    async pendingFor(change): Promise<PendingOffer | undefined> {
      for (const thread of await threadsFor(change)) {
        const task = await readTask(flow, thread.taskId);
        const workflow = task?.workflow;
        if (task === undefined || workflow === undefined) continue;
        const approval = approvalOfferOf(task.taskId, workflow);
        const context = approval === undefined ? undefined : await contextOf({ companyId, requestId: approval.requestId, kind: approval.kind, subject: { type: "task", id: task.taskId }, revision: approval.revision, artifactDigest: approval.artifactDigest });
        if (approval !== undefined && context !== undefined) return { taskId: task.taskId, approval, postedAt: context.postedAt, repository: thread.repositoryKey };
      }
      return undefined;
    },
    decide: (input) => options.decisions.decideFromComment(input),
    async lesson() { return { ok: false, reason: "refused", message: "Lessons are not on this install yet." }; },
    async stop(change) {
      const [thread] = await threadsFor(change);
      const task = thread === undefined ? undefined : await readTask(flow, thread.taskId);
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
        const isBot = comment.author.accountType === "Bot" || comment.author.login.endsWith("[bot]");
        // The author's standing is asked only about a comment that is a command: the rest are dropped before it matters.
        const command = /^\s*\/rovara\b/u.test(comment.body);
        return {
          body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt, author: { provider: thread.host.kind, tenant: "", accountId: comment.author.login },
          authorPermission: command && !isBot ? await standingOf(thread, comment.author.login, pollBudget) : "none", authorIsBot: isBot, on: onOf(thread, comment),
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

  return {
    fetchComment, contextOf,
    available: () => registry.names("code-host").some((kind) => registry.get("code-host", kind)?.comments !== undefined),

    async attachThread(taskId, input) {
      const task = await readTask(flow, taskId);
      if (task === undefined || task.companyId !== companyId || task.closedAt !== undefined) throw agentXError("NOT_FOUND", "There is no open task with that id.");
      // Only a repository of the task's own project: a comment from a writer elsewhere must never decide this task.
      const project = await flow.projects.revision(task.project, task.startingRevision);
      const definition = project?.definition.repositories.find((entry) => entry.name === input.repository);
      if (definition === undefined || !Number.isSafeInteger(input.number) || input.number < 1) throw agentXError("CONFIG_INVALID", "name a repository of the task's project and an issue or pull request number");
      await store.put({ item: jsonOf({ ...threadRowKey(taskId), entityType: "COMMENT_THREAD", taskId, repositoryId: input.repository, number: input.number, attachedAt: iso(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + CURSOR_KEEP_SECONDS }) });
    },

    async poll() {
      const result = { threads: 0, comments: 0, handled: 0 };
      const at = now();
      const pausedUntil = options.paused?.();
      if (pausedUntil !== undefined || (lastPoll !== undefined && at - lastPoll < pollMs)) return result;
      lastPoll = at;
      const { budget, stop } = createReadBudget(now, { requests: POLL_MAX_REQUESTS, ms: POLL_MAX_MS });
      pollBudget = budget;
      try {
        const unique = new Map<string, Thread>();
        for (const thread of await allThreads()) if (thread.host.comments !== undefined) unique.set(`${thread.repositoryKey}#${String(thread.number)}`, thread);
        for (const thread of [...unique.values()].slice(0, POLL_MAX_THREADS)) {
          result.threads += 1;
          const cursor = await store.get(cursorKey(thread));
          const since = typeof cursor?.["since"] === "string" ? cursor["since"] : thread.since;
          let newest = Date.parse(since);
          try {
            let page: number | undefined = 1;
            for (let read = 0; page !== undefined && read < POLL_PAGES_MAX; read += 1) {
              const answered = await thread.host.comments!(changeRequestRef(thread.url, thread.number), { since, page }, scope, budget);
              for (const comment of answered.comments) {
                result.comments += 1;
                seen.set(comment.id, { thread, comment });
                const event: PrCommentEvent = { companyId, action: "created", repository: thread.repositoryKey, number: thread.number, commentId: comment.id };
                const outcome: PrCommandOutcome = await commands.handle(event);
                if (outcome.handled) result.handled += 1;
                newest = Math.max(newest, Date.parse(comment.updatedAt));
              }
              page = answered.nextPage;
            }
          } catch (error) {
            const limitedUntil = hostRateLimitRetryAt(error);
            if (limitedUntil !== undefined) { options.pauseUntil?.(limitedUntil); break; }
            // A comment whose command failed is given back (the handler removes its claim) and is read again by the next poll: the cursor stays before it.
            log({ component: "pr_comments", event: "poll.thread_failed", error: error instanceof Error ? error.name : "unknown" });
            continue;
          } finally {
            seen.clear();
          }
          await store.put({ item: jsonOf({ ...cursorKey(thread), entityType: "COMMENT_CURSOR", since: new Date(newest).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + CURSOR_KEEP_SECONDS }) }).catch(() => undefined);
        }
      } catch (error) {
        const limitedUntil = hostRateLimitRetryAt(error);
        if (limitedUntil !== undefined) options.pauseUntil?.(limitedUntil);
        else log({ component: "pr_comments", event: "poll.failed", error: error instanceof Error ? error.name : "unknown" });
      } finally {
        stop();
        pollBudget = undefined;
      }
      return result;
    },
  };
}

