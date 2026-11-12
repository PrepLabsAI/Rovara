// The notice service: what needs a person reaches them in their chat (or their email, where the host's email point can send), batched. A host composes it over its own adapters:
//
//   queue    a session's committed change into a state that asks someone to act (or that ended) writes one pending row per person to tell (`queueAttention`); use `queue` as a session change hook.
//   deliver  one sweep batches what is pending into at most one message per target every few minutes (`deliverAttention`), through the `channel` adapters and the `email` point the registry holds.
//
// Nothing here says who the person is or how to reach the page that shows a task: the host passes the words (`footer`, `link`) and the rules (`access`, `urgent`, `companyOf`, `address`). A host with no channel
// or email adapter that can send queues and delivers nothing (`canNotify` is false).
import type { DocumentStore, OrgId, RealtimePublisher, RegistryView } from "@agentx/contracts";
import { readTaskThread } from "../core/channel/threads.js";
import { deliverAttention, queueAttention, type AttentionDeliveryDependencies, type AttentionOutcome } from "../core/notify/attention.js";
import type { SessionChange } from "../core/sessions/summary.js";

type DeliveryOptions = Pick<AttentionDeliveryDependencies, "link" | "maxTargets" | "footer" | "thread" | "companyOf" | "access" | "address" | "urgent" | "emailLinks" | "doneToldInThread" | "planCarded">;

export interface NoticeServiceOptions extends DeliveryOptions {
  store: DocumentStore;
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
  /** One delivery sweep, stopping new work at the deadline. Nothing when nobody can be told. */
  deliver(budget?: { deadlineMs?: number }): Promise<AttentionOutcome | undefined>;
}

export function createNoticeService(options: NoticeServiceOptions): NoticeService {
  const { store, registry } = options;
  const clock = options.now ?? (() => new Date());
  const canNotify = (): boolean => registry.names("channel").length > 0 || registry.names("email").some((name) => registry.get("email", name)?.capabilities.available === true);
  const realtime = (): Pick<RealtimePublisher, "publish"> | undefined => registry.get("realtime", registry.names("realtime")[0] ?? "");
  return {
    canNotify,
    async queue(change) {
      if (!canNotify()) return;
      await queueAttention({ store, now: clock, ...(options.log === undefined ? {} : { log: options.log }), realtime: realtime() }, change);
    },
    async deliver(budget = {}) {
      if (!canNotify()) return undefined;
      const { store: _store, registry: _registry, now: _now, log, ...rest } = options; // eslint-disable-line @typescript-eslint/no-unused-vars -- the rest are the delivery's own options
      return deliverAttention({
        store, registry, now: () => clock().getTime(), ...rest, thread: options.thread ?? ((org: OrgId, sessionId: string) => readTaskThread(store, org, sessionId)), ...(log === undefined ? {} : { log }),
      }, budget);
    },
  };
}
