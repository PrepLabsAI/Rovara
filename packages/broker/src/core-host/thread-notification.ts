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
import type { AdapterRegistry, DocumentStore, OrgId } from "@agentx/contracts";
import { channelThreadHandler, planCardPosted, setupPausedPosted } from "../core/channel/thread-notices.js";
import type { CodeMilestoneHandler } from "../core/milestones/milestones.js";
import type { ChannelMemberRule } from "../core/channel/company.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { hostedDecisionService } from "./deployed-decisions.js";
import { readTaskThread } from "../core/channel/threads.js";
import { projectPageUrl, sessionPageUrl } from "../core/decisions/open-path.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { ChatThreads } from "./chat-threads.js";
import type { CoreServiceWiring } from "./core-runtime.js";

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

export function hostedThreadNotification(input: HostedThreadNotificationInputs): NonNullable<CoreServiceWiring["notification"]> {
  const { threads, registry, companyId, store } = input;
  return {
    registry: {
      get: ((point: string, name: string) => (point === "channel" ? threads.adapterFor(companyId, name) : registry.get(point as never, name))) as never,
      names: ((point: string) => (point === "channel" ? [...threads.channels] : registry.names(point as never))) as never,
    },
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
}

/**
 * What a hosted company's chat thread is told of its task: the plan's approval card, the setup pause with its link, the pull request and the end (`core/channel/thread-notices.ts`), through this company's own chat adapter only.
 * The card reads the SAME gate the web's decision cards use (the company's approvers point) and nothing else of it: the handler is handed `requirement` alone, so a chat can post a card but never decide. The hosted approvers offer
 * one method (a fresh step-up proved on the web), so the card is the sign-in card: the plan's risk and a link to the task's page, no button. The addresses are the web app's own.
 */
export function hostedThreadHandler(input: HostedThreadHandlerInputs): CodeMilestoneHandler {
  const { threads, registry, companyId, deps } = input;
  const gate = hostedDecisionService({ deps, registry, companyId, now: input.clock }).gate;
  return channelThreadHandler({
    store: registry.require("storage"), registry: { get: ((point: string, name: string) => (point === "channel" ? threads.adapterFor(companyId, name) : undefined)) as never },
    now: input.now, companyOf: threads.companyOf, isMember: input.isMember,
    plan: { gate: { requirement: (orgId, kind, subjectId) => gate.requirement(orgId, kind, subjectId) } },
    // The task's page on the web app: its session's when it has one, else its project's (the same rule as a decision card's "Open", `taskOpenPath`).
    taskUrl: (_taskId, task) => (task?.sessionId === undefined ? projectPageUrl(input.origin(), task?.project) : sessionPageUrl(input.origin(), task.sessionId)),
    setupUrl: (project) => projectPageUrl(input.origin(), project),
    log: input.log,
  });
}
