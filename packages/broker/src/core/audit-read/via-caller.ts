// "Person via caller" (lane AU): every engine action that goes through an audit sink names the caller it came through, next to the person who did it. The wrapper stamps the caller's word on each event as the one
// fact `via`; the engine is built once per request with the caller it knows (the web client, Slack, the CLI), so no call site has to remember. The caller's word wins over any `via` an event brings itself.
import { AuditViaSchema, type AuditEvent, type AuditSink } from "@agentx/contracts";

/** An audit sink that records everything the given sink records, with `details.via` set to `via`. Throws for a word that is not a caller name. */
export function auditViaCaller(sink: AuditSink, via: string): AuditSink {
  if (!AuditViaSchema.safeParse(via).success) throw new Error("a caller name is a short lower-case word");
  const stamped = (event: AuditEvent): AuditEvent => ({ ...event, details: { ...(event.details ?? {}), via } });
  return {
    stage: (event) => sink.stage(stamped(event)),
    record: (event) => sink.record(stamped(event)),
  };
}
