// Port lane W0, policy seam: the audit sink.
//
// Cloud writes an audit ledger, and the ledger row commits in the same document-store transaction as the change it records (the
// Ask, diagnosis and lesson audits work this way today). Code writes nothing. The port is only this interface: the ledger, its
// verifier and its outbox stay in Cloud (decision 41).
import type { JsonObject } from "./json.js";
import type { PolicySubject } from "./policy.js";
import type { TransactItem } from "./document-store.js";

export interface AuditActor {
  type: "person" | "agent" | "system";
  /** The person's Rovara id, an agent's name, or the name of the system part. Never a provider's raw account handle on its own. */
  id: string;
}

export interface AuditEvent {
  /** Names the event for good; recording the same id twice records it once. */
  eventId: string;
  companyId: string;
  at: string;
  actor: AuditActor;
  /** Dotted lower-case words, such as `task.approved` or `lessons.read`. */
  action: string;
  subject?: PolicySubject;
  /** Facts for a reader of the ledger. Never a secret, a token or a key. */
  details?: JsonObject;
}

export interface AuditSink {
  /**
   * The steps to add to the caller's `DocumentStore.transact` call so the record commits with the change, or none when this sink
   * writes somewhere else. The caller adds them as given and does not look inside.
   */
  stage(event: AuditEvent): readonly TransactItem[];
  /** Records an event on its own, for a caller that has no transaction. Resolves when it is durable. */
  record(event: AuditEvent): Promise<void>;
}
