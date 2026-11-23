// The notice service: what needs a person reaches them in their chat (or their email, where the host's email point can send), batched. A host composes it over its own adapters:
//
//   queue    a session's committed change into a state that asks someone to act (or that ended) writes one pending row per person to tell (`queueAttention`); use `queue` as a session change hook.
//   deliver  one sweep batches what is pending into at most one message per target every few minutes (`deliverAttention`), through the `channel` adapters and the `email` point the registry holds.
//
// Nothing here says who the person is or how to reach the page that shows a task: the host passes the words (`footer`, `link`) and the rules (`access`, `urgent`, `companyOf`, `address`). A host with no channel
// or email adapter that can send queues and delivers nothing (`canNotify` is false).
import type { DocumentStore, OrgId, RealtimePublisher, RegistryView } from "@agentx/contracts";
import { readTaskThread } from "../core/channel/threads.js";
import { deliverAttention, queueAdminNotice, queueAttention, type AdminNoticeKind, type AttentionBudget, type PeopleOf, type AttentionDeliveryDependencies, type AttentionOutcome } from "../core/notify/attention.js";
import type { SessionChange } from "../core/sessions/summary.js";

type DeliveryOptions = Pick<AttentionDeliveryDependencies, "link" | "maxTargets" | "footer" | "thread" | "companyOf" | "access" | "address" | "urgent" | "emailLinks" | "doneToldInThread" | "planCarded" | "setupPausedTold" | "upkeep" | "adminNotice" | "e2e">;

export interface NoticeServiceOptions extends DeliveryOptions {
  store: DocumentStore;
  /** The hosted core: when nothing can message anyone, still keep each person's in-app inbox rows (and nothing else). Absent: a host that can tell nobody queues nothing, as before. */
  inbox?: boolean;
  /** Called after attention rows were written for a change (the hosted attention email's reverse index, `core/notify/person-index.ts`). Never a reason for the queue to fail. Absent: nothing. */
  remember?: (change: SessionChange) => Promise<void>;
  /** The task's People (co-owners and commenters) as attention ids: told with the owner and the followers (`attentionRecipients`). Absent: nobody else on the task is told, as before. */
  peopleOf?: PeopleOf;
  /** Where the adapters are: the `channel` points, the `email` point and, for the open pages' hint, the `realtime` point. */
  registry: Pick<RegistryView, "get" | "names">;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export interface NoticeService {
  /** Whether anything can be told at all: a chat adapter is registered, or an email point that can send. With neither, nothing is queued. */
  canNotify(): boolean;
  /** A session change hook: queues what the change calls for. Never throws. */
  queue(change: SessionChange): Promise<void>;
  /** An admin notice (not about a task) for the people named. Nothing when nobody can be told. Never throws; answers how many rows were queued. */
  queueAdmin(notice: { orgId: string; developerIds: readonly string[]; noticeId: string; kind: AdminNoticeKind }): Promise<number>;
  /** One delivery sweep, stopping new work at the deadline. Nothing when nobody can be told. */
  deliver(budget?: AttentionBudget): Promise<AttentionOutcome | undefined>;
}

export function createNoticeService(options: NoticeServiceOptions): NoticeService {
  const { store, registry } = options;
  const clock = options.now ?? (() => new Date());
  const canNotify = (): boolean => registry.names("channel").length > 0 || registry.names("email").some((name) => registry.get("email", name)?.capabilities.available === true);
  const realtime = (): Pick<RealtimePublisher, "publish"> | undefined => registry.get("realtime", registry.names("realtime")[0] ?? "");
  return {
    canNotify,
    async queue(change) {
      // Nothing can message anyone: the hosted core still keeps the inbox rows (no pending rows, which nothing would deliver); every other host queues nothing.
      if (!canNotify() && options.inbox !== true) return;
      const told = await queueAttention({ store, now: clock, ...(options.log === undefined ? {} : { log: options.log }), realtime: realtime(), ...(options.peopleOf === undefined ? {} : { peopleOf: options.peopleOf }), ...(canNotify() ? {} : { pending: false }) }, change);
      if (told > 0 && options.remember !== undefined) { try { await options.remember(change); } catch { /* never a reason for the queue to fail */ } }
    },
    queueAdmin: (notice) => queueAdminNotice({ store, now: clock, ...(options.log === undefined ? {} : { log: options.log }), pending: canNotify() }, notice),
    async deliver(budget = {}) {
      if (!canNotify()) return undefined;
      const { store: _store, registry: _registry, now: _now, log, peopleOf: _peopleOf, ...rest } = options; // eslint-disable-line @typescript-eslint/no-unused-vars -- the rest are the delivery's own options
      return deliverAttention({
        store, registry, now: () => clock().getTime(), ...rest, thread: options.thread ?? ((org: OrgId, sessionId: string) => readTaskThread(store, org, sessionId)), ...(log === undefined ? {} : { log }),
      }, budget);
    },
  };
}
