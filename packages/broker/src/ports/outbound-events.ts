// Port lane P6 (item R3): sends one event to every registered `outbound-events` adapter that wants its type. The event is validated first (a bad event is the caller's bug and throws); a failing adapter never
// stops the others or the caller's work. Each adapter has a time limit, and a failure is reported by adapter name and a FIXED kind (`timeout`, `accepts_failed`, `delivery_failed`), never the adapter's own error
// name or text (an adapter can set either to anything, and its error can carry a URL or a secret). Delivery is at least once: a caller that needs a retry keeps the event and calls again with the SAME `id`; the
// adapters drop a repeat. A delivery that timed out may still complete later, which is the same at-least-once rule.
import { OutboundEventSchema, type OutboundEvent, type OutboundEventInput, type RegistryView } from "@agentx/contracts";

export const OUTBOUND_DELIVERY_TIMEOUT_MS = 10_000;

export type OutboundFailureKind = "timeout" | "accepts_failed" | "delivery_failed";

export interface OutboundPublishResult {
  event: OutboundEvent;
  /** Adapters that accepted the event. */
  delivered: string[];
  /** Adapters that did not want this type. */
  skipped: string[];
  /** Adapters that failed, with the kind of failure. */
  failed: Array<{ adapter: string; error: OutboundFailureKind }>;
}

class DeliveryFailure extends Error {
  constructor(readonly kind: OutboundFailureKind) {
    super(kind);
  }
}

export async function publishOutboundEvent(registry: Pick<RegistryView, "get" | "names">, input: OutboundEventInput, options: { timeoutMs?: number } = {}): Promise<OutboundPublishResult> {
  const event = OutboundEventSchema.parse(input);
  const timeoutMs = options.timeoutMs ?? OUTBOUND_DELIVERY_TIMEOUT_MS;
  const result: OutboundPublishResult = { event, delivered: [], skipped: [], failed: [] };
  const names = [...registry.names("outbound-events")].sort();
  const settled = await Promise.allSettled(names.map(async (name) => {
    const adapter = registry.get("outbound-events", name);
    if (adapter === undefined) return "skipped" as const;
    let wanted: boolean;
    try {
      wanted = adapter.accepts === undefined || adapter.accepts(event.type);
    } catch {
      // An adapter that cannot say whether it wants an event is broken, not uninterested: report it.
      throw new DeliveryFailure("accepts_failed");
    }
    if (!wanted) return "skipped" as const;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => adapter.deliver(structuredClone(event))).catch(() => { throw new DeliveryFailure("delivery_failed"); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DeliveryFailure("timeout")), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return "delivered" as const;
  }));
  settled.forEach((outcome, index) => {
    const adapter = names[index] as string;
    if (outcome.status === "fulfilled") (outcome.value === "delivered" ? result.delivered : result.skipped).push(adapter);
    else result.failed.push({ adapter, error: outcome.reason instanceof DeliveryFailure ? outcome.reason.kind : "delivery_failed" });
  });
  return result;
}
