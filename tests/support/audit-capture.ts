// TEST SUPPORT: a capturing audit sink. `capturingAuditDeps` keeps the call shape the context-source tests were written with: `deps` is what the audit hooks take (here, the audit sink), `recorded()`
// the events it was given, in order.
import type { AuditEvent, AuditSink } from "@agentx/contracts";

export function capturingAuditDeps(options?: unknown) {
  void options;
  const events: AuditEvent[] = [];
  const deps: AuditSink = { stage: () => [], record: async (event) => { events.push(event); } };
  return { deps, recorded: (): AuditEvent[] => [...events] };
}
