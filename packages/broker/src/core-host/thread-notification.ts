// HW5: what the hosted notice service needs so a task started from a chat thread is told what needs a person in THAT thread (and any notice links to the task's page), the same as on a laptop (`local/app/app.ts` `createNoticeService`).
//
//   registry          the company's own registry, with its `channel` point served by the company-scoped chat seam (`ChatThreads`): an adapter made for company A reaches company A's workspaces only, with A's token.
//   companyOf         which company a chat tenant belongs to: a thread of another company's tenant (or nobody's) is never sent to.
//   thread            the conversation a session was started from and WHO started it, as the notice rows name a person (the session's developer id, a hash of the person). Read from the company's own thread row, and only while that person is
//                     still a live member of this company (the identity point, never a stored claim); anything else, or a read that fails, is no thread.
//   link              the task's page (`<origin>/app/sessions/<id>`), a plain https address or nothing.
//   planCarded        the plan's approval card was already posted in the thread for this plan, so the needs-you reminder is not sent there again.
//   setupPausedTold   the same for the setup pause message.
//   doneToldInThread  the thread's own "done" line is told by the thread's milestones, only where those run (the company has milestones).
import type { AdapterRegistry, DocumentStore, OrgId, WorkflowSnapshot } from "@agentx/contracts";
import type { OfferCapabilities } from "../core/task-actions/index.js";
import { channelThreadHandler, planCardPosted, setupPausedPosted } from "../core/channel/thread-notices.js";
import type { CodeMilestoneHandler } from "../core/milestones/milestones.js";
import { PendingMilestoneDelivery } from "../core/milestones/pending-delivery.js";
import type { ChannelMemberRule } from "../core/channel/company.js";
import type { AttentionDeliveryDependencies } from "../core/notify/attention.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { hostedDecisionService } from "./deployed-decisions.js";
import { readTaskThread, type TaskThread } from "../core/channel/threads.js";
import { projectPageUrl, sessionPageUrl } from "../core/decisions/open-path.js";
import { developerIdOf } from "../core/sessions/create.js";
import { threadDocumentLink, threadCanvasCloseout } from "./thread-documents.js";
import { createCompanyArtifactReader } from "./company-artifact-reader.js";
import { workflowDocumentTextReader } from "../core/plan/document.js";
import { workflowThreadRefresh } from "../core/channel/workflow-notices.js";
import { taskKey } from "../core/task-flow/keys.js";
import { workflowMessage } from "../developer/workflow-messages.js";
import { agentSessionKey } from "@agentx/contracts";
import type { ChatThreads } from "./chat-threads.js";

export interface HostedThreadNotificationInputs {
  threads: ChatThreads;
  registry: AdapterRegistry;
  companyId: OrgId;
  store: DocumentStore;
  now: () => number;
  /** The web app's origin (undefined: no link). */
  origin: () => string | undefined;
  /** Whether the thread's own milestone handler runs for this company (so its "done" line is not told twice). */
  threadsTold: boolean;
}

/**
 * The company's registry as the notices read it: the `channel` point is the company-scoped chat seam's (an adapter made for company A reaches company A's workspaces only, with A's token), every other point is the registry's.
 * One function for the thread notices (`hostedThreadNotification`) and the weekly lessons summary (B6), so both reach the chats the same way and neither can reach another company's.
 */
export function hostedChannelView(threads: Pick<ChatThreads, "adapterFor" | "channels">, registry: Pick<AdapterRegistry, "get" | "names">, companyId: OrgId): Pick<AdapterRegistry, "get" | "names"> {
  return {
    get: ((point: string, name: string) => (point === "channel" ? threads.adapterFor(companyId, name) : registry.get(point as never, name))) as never,
    names: ((point: string) => (point === "channel" ? [...threads.channels] : registry.names(point as never))),
  };
}

export function hostedThreadNotification(input: HostedThreadNotificationInputs): Pick<AttentionDeliveryDependencies, "registry" | "companyOf" | "link" | "thread" | "planCarded" | "setupPausedTold" | "doneToldInThread"> {
  const { threads, registry, companyId, store } = input;
  return {
    registry: hostedChannelView(threads, registry, companyId),
    companyOf: threads.companyOf,
    link: (session) => (session.orgId === companyId ? sessionPageUrl(input.origin(), session.sessionId) : undefined),
    async thread(orgId, sessionId) {
      if (orgId !== companyId) return undefined;
      const row = await readTaskThread(store, orgId, sessionId);
      if (row === undefined) return undefined;
      const person = await registry.require("identity").getPrincipal(orgId, row.personId);
      if (person === undefined || person.companyId !== orgId || person.personId !== row.personId) return undefined;
      return { conversation: row.conversation, personId: developerIdOf(person) };
    },
    planCarded: planCardPosted({ store, now: input.now }),
    setupPausedTold: setupPausedPosted({ store }),
    doneToldInThread: () => input.threadsTold,
  };
}

export interface HostedThreadHandlerInputs {
  threads: ChatThreads;
  registry: AdapterRegistry;
  companyId: OrgId;
  deps: TaskFlowDeps;
  now: () => number;
  /** The same clock as a date (the decision service's). */
  clock: () => Date;
  origin: () => string | undefined;
  /** Whether the person who started the task is still this company's member. */
  isMember: ChannelMemberRule;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** S1: what the host can serve of the task action registry. Cards carry task action buttons only where it is given AND the thread's adapter declares `taskActions` (the host wired the press). */
  taskActions?: OfferCapabilities | undefined;
}

/**
 * What a hosted company's chat thread is told of its task: the plan's approval card, the setup pause with its link, the pull request and the end (`core/channel/thread-notices.ts`), through this company's own chat adapter only.
 * The card reads the SAME gate the web's decision cards use (the company's approvers point) and nothing else of it: the handler is handed `requirement` alone, so this handler can post a card but never decide (a press on the card is decided by `chat-decision.ts`, through the same gate). Where the approvers offer the chat's own method (low and medium risk, HW5b) the card has Approve and Request changes; otherwise (high risk, or no chat method) it is the sign-in card: the plan's risk and a link to the task's page, no button. The addresses are the web app's own.
 */
export function hostedThreadHandler(input: HostedThreadHandlerInputs): CodeMilestoneHandler {
  const { threads, registry, companyId, deps } = input;
  const gate = hostedDecisionService({ deps, registry, companyId, now: input.clock }).gate;
  const documents = { store: registry.require("storage"), blobs: registry.require("object-storage"), readArtifact: workflowDocumentTextReader(deps, createCompanyArtifactReader({ store: registry.require("storage"), blobs: registry.require("object-storage"), companyId })), companyId, now: input.now, ...(threads.documentFailure === undefined ? {} : { documentFailure: threads.documentFailure.bind(threads) }), ...(threads.createPlanCanvas === undefined ? {} : { createPlanCanvas: threads.createPlanCanvas.bind(threads) }) };
  const commandFor = (thread: TaskThread) => {
    const adapter = threads.adapterFor(companyId, thread.conversation.channel);
    if (adapter === undefined) throw new Error("thread adapter is unavailable");
    return { adapter, channel: thread.conversation.channel, orgId: companyId, companyOf: threads.companyOf, now: input.now };
  };
  return channelThreadHandler({
    store: registry.require("storage"), registry: { get: ((point: string, name: string) => (point === "channel" ? threads.adapterFor(companyId, name) : undefined)) as never },
    now: input.now, companyOf: threads.companyOf, isMember: input.isMember,
    plan: { gate: { requirement: (orgId, kind, subjectId) => gate.requirement(orgId, kind, subjectId) } },
    // The task's page on the web app: its session's when it has one, else its project's (the same rule as a decision card's "Open", `taskOpenPath`).
    taskUrl: (_taskId, task) => (task?.sessionId === undefined ? projectPageUrl(input.origin(), task?.project) : sessionPageUrl(input.origin(), task.sessionId)),
    setupUrl: (project) => projectPageUrl(input.origin(), project),
    document: async (taskId, workflow, thread) => {
      const task = await documents.store.get(taskKey(taskId));
      if (task?.["companyId"] !== companyId) return {};
      const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : undefined;
      return threadDocumentLink(documents, { taskId, title: typeof task["title"] === "string" ? task["title"] : "Plan" }, workflow, thread.conversation.space, thread.conversation.tenant, sessionId === undefined ? undefined : sessionPageUrl(input.origin(), sessionId));
    },
    closeout: async (taskId, thread) => {
      const task = await documents.store.get(taskKey(taskId));
      const workflow = task?.["workflow"] as WorkflowSnapshot | undefined;
      const words = workflow?.stage === "MERGED" || workflow?.stage === "CLOSED" ? workflowMessage({ taskId, workflow })?.text : undefined;
      if ((workflow?.canvasLineage?.length ?? 0) === 0) return words;
      // A pending deletion must keep the milestone due. The thread handler posts
      // the final notice independently before propagating this retryable failure.
      const cleanup = await threadCanvasCloseout(documents, commandFor(thread), thread.conversation.tenant, taskId);
      if (cleanup.status !== "COMPLETE") throw new PendingMilestoneDelivery("Canvas closeout remains pending");
      return words;
    },
    ...(input.taskActions === undefined ? {} : { taskActions: input.taskActions }),
    log: input.log,
  });
}

/** Every session refresh retries the current workflow's additional thread notice. */
export function hostedWorkflowThreadRefresh(input: HostedThreadHandlerInputs) {
  const refreshFor = (store: DocumentStore) => workflowThreadRefresh({ store, companyId: input.companyId, now: input.now,
    messageOf: (message) => input.threads.messageOf?.(message), registry: hostedChannelView(input.threads, input.registry, input.companyId), companyOf: input.threads.companyOf, isMember: input.isMember,
    taskUrl: (_taskId, task) => task?.sessionId === undefined ? undefined : sessionPageUrl(input.origin(), task.sessionId), ...(input.taskActions === undefined ? {} : { taskActions: input.taskActions }), log: input.log });
  return async (orgId: OrgId, sessionId: string, store: DocumentStore) => {
    if (orgId !== input.companyId) return;
    const session = await store.get(agentSessionKey(orgId, sessionId, "META"));
    const subject = session?.["subject"] as { kind?: string; taskId?: string } | undefined;
    if (subject?.kind === "task" && typeof subject.taskId === "string") await refreshFor(store)(orgId, sessionId, subject.taskId);
  };
}
