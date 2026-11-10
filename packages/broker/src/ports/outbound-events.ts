// Port lane P6 (item R3): sends one event to every registered `outbound-events` adapter that wants its type. The event is validated first (a bad event is the caller's bug and throws); a failing adapter never
// stops the others or the caller's work: its name is in the result, with the kind of error and no text (an adapter's error can carry a URL or a secret). Delivery is at least once: a caller that needs a retry
// keeps the event and calls again with the SAME `id`; the adapters drop a repeat.
import { OutboundEventSchema, type OutboundEvent, type OutboundEventInput, type RegistryView } from "@agentx/contracts";

export interface OutboundPublishResult {
  event: OutboundEvent;
  /** Adapters that accepted the event. */
  delivered: string[];
  /** Adapters that did not want this type. */
  skipped: string[];
  /** Adapters that failed, with the kind of error. */
  failed: Array<{ adapter: string; error: string }>;
}

export async function publishOutboundEvent(registry: Pick<RegistryView, "get" | "names">, input: OutboundEventInput): Promise<OutboundPublishResult> {
  const event = OutboundEventSchema.parse(input);
  const result: OutboundPublishResult = { event, delivered: [], skipped: [], failed: [] };
  const names = [...registry.names("outbound-events")].sort();
  const settled = await Promise.allSettled(names.map(async (name) => {
    const adapter = registry.get("outbound-events", name);
    if (adapter === undefined) return "skipped" as const;
    let wanted: boolean;
    try {
      wanted = adapter.accepts === undefined || adapter.accepts(event.type);
    } catch {
      wanted = false;
    }
    if (!wanted) return "skipped" as const;
    await adapter.deliver(structuredClone(event));
    return "delivered" as const;
  }));
  settled.forEach((outcome, index) => {
    const adapter = names[index] as string;
    if (outcome.status === "fulfilled") (outcome.value === "delivered" ? result.delivered : result.skipped).push(adapter);
    else result.failed.push({ adapter, error: outcome.reason instanceof Error ? outcome.reason.name : "error" });
  });
  return result;
}
