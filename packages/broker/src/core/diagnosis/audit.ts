// Fix with agent: the audit records of a diagnosis, for the `audit-sink` port. Ids, fixed words and counts only: the error's text, the model's answer and the proposals' words never enter an event. The action names and
// the detail fields are the hosted ledger's (`diagnosis.started`, `diagnosis.proposed`), so a ledger behind the port reads them the same way. Each event commits with the change it records (`AuditSink.stage`).
import type { AuditEvent, DiagnosisProposal } from "@agentx/contracts";
import { proposalCounts } from "./sanitize.js";

interface Base { companyId: string; developerId: string; at: string; diagnosisId: string }

/** A person asked for a diagnosis. `errorKind`, `errorCode` and `tier` are fixed words. */
export function diagnosisStartedEvent(input: Base & { errorKind: string; errorCode: string; tier: "light" | "deep" }): AuditEvent {
  return {
    eventId: `diagnosis:${input.diagnosisId}:started`, companyId: input.companyId, at: input.at, actor: { type: "person", id: input.developerId }, action: "diagnosis.started",
    subject: { type: "diagnosis", id: input.diagnosisId }, details: { errorKind: input.errorKind, errorCode: input.errorCode, tier: input.tier },
  };
}

/** A diagnosis was answered: how many proposals survived, by kind, and how many were dropped. */
export function diagnosisProposedEvent(input: Base & { proposals: readonly DiagnosisProposal[]; dropped: number }): AuditEvent {
  const counts = proposalCounts(input.proposals);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    eventId: `diagnosis:${input.diagnosisId}:proposed`, companyId: input.companyId, at: input.at, actor: { type: "person", id: input.developerId }, action: "diagnosis.proposed",
    subject: { type: "diagnosis", id: input.diagnosisId }, details: { total, dropped: input.dropped, ...counts },
  };
}
