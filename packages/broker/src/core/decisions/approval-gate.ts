// The approval gate (port lane L6b, owner decision 45.3). Approvals are authority: this is the one place that turns "a person says yes" into a committed decision, for every surface (a local
// page, the CLI, the MCP tools, a pull request comment). It is new in Code; the hosted product's per-surface checks (browser session, recent sign-in, second person) are Approvers-seam rules there.
//
// What it guarantees, each one tested:
//   - the request is built from the CURRENT stored state of the subject (revision, content digest, risk), never from anything the caller sent. The caller sends only what the person SAW
//     (`seen`), and that must equal the current state, else the answer is "stale". A plan revised after the person looked cannot be approved by their yes.
//   - authority comes from the Approvers seam: `verify` checks the proof against its issuer (the local session, or the code host's comment looked up by id). The gate never believes a principal or an account
//     that a caller names. A proof the seam refuses is refused whole, with the seam's reason.
//   - a proof is single use: the marker `approvalProofKey(proof)` is written with `when.absent()` in the SAME transaction as the decision, so two racing requests cannot both succeed even across processes. One request id
//     is decided once, by the same rule (the decision record is written with `when.absent()`).
//   - the change to the subject carries the condition the subject loaded it under (its revision and that it still waits), so a concurrent change loses; the whole decision is one transaction.
//   - policy on top of the seam, which only narrows what it allows: a high-risk approval, and every rejection or request for changes, accept only the local session (a comment is an approval of a change request, and
//     says nothing about a rejection); a request that does not allow self-approval refuses the person who asked; `minApprovers` distinct approvers are needed.
//   - nothing a caller can send widens it: an unknown kind, subject or method is a refusal, not a default.
// It never throws for a refusal (a refusal is an answer); it throws only for a fault of the store.
import { randomUUID } from "node:crypto";
import {
  INDEX_EXPIRY_ATTRIBUTE, approvalProofKey, companyScoped, when,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type Approvers, type AuditSink, type Condition, type DocumentKey, type DocumentStore, type ExternalAccountRef, type Principal,
  type StoredDocument, type TransactItem, type UpdateOp,
} from "@agentx/contracts";

export type DecisionOutcome = "approve" | "reject" | "request_changes";

/** The state of a subject as the gate needs it. Loaded fresh for every attempt. */
export interface LoadedSubject {
  /** The document the decision changes. */
  key: DocumentKey;
  /** Holds only while the loaded state is current (its revision, and that it still waits). The gate puts it on the update. */
  guard: Condition;
  /** Still waiting for this kind of decision. */
  waiting: boolean;
  /** What the Approvers seam is asked about. The gate fills `companyId` and `requestId`. */
  request: Omit<ApprovalRequest, "companyId" | "requestId">;
  /** Anything the subject keeps to apply the decision (opaque to the gate). */
  state: unknown;
}

/** A subject refused the decision for a reason of its own (the transition is not allowed, the outcome is not offered). Never carries a secret. */
export class SubjectRefusal extends Error {
  constructor(readonly code: "invalid_outcome" | "not_the_approver" | "invalid", message: string) {
    super(message);
    this.name = "SubjectRefusal";
  }
}

export interface AppliedDecision {
  /** Changes to the subject's document, under the subject's guard. */
  ops: readonly UpdateOp[];
  /** More steps for the same transaction (a milestone, an outbox message, a comment lock). They must not name the subject's key or the gate's own keys. */
  extra?: readonly TransactItem[];
  /** Facts for the caller, returned as given. */
  result?: Record<string, unknown>;
}

export interface DecisionSubject {
  /** The kind of subject: `workflow-document`. A caller names it; an unknown name is refused. */
  readonly kind: string;
  load(companyId: string, subjectId: string): Promise<LoadedSubject | undefined>;
  /** Works out what the decision changes. Throws `SubjectRefusal`. Pure apart from reading `loaded`. */
  apply(loaded: LoadedSubject, attempt: DecisionAttempt, approver: Principal, at: string): AppliedDecision | Promise<AppliedDecision>;
}

/** What a person presents. The token is checked by the method's issuer and is never stored or logged. */
export interface Credential {
  method: string;
  token: string;
  claimedAccount?: ExternalAccountRef;
}

export interface DecisionAttempt {
  companyId: string;
  kind: string;
  subjectId: string;
  /** Names this decision; a repeat of the same decision is answered again, a different decision under the same id is refused. */
  requestId: string;
  outcome: DecisionOutcome;
  /** What the person saw when they decided. */
  seen: { revision: number; artifactDigest: string };
  /** One credential, or several when the Approvers seam asks for more than one approver. */
  credentials: readonly Credential[];
  /** The person's one-line reason (a rejection's or a request for changes'). Cut to 500 characters. */
  reason?: string;
  /** Subject-specific input (a plan's answers and comments). Opaque to the gate. */
  details?: unknown;
}

export type GateRefusalReason =
  | "unsupported" | "invalid" | "not_found" | "not_waiting" | "stale" | "expired"
  | "method_not_allowed" | "not_approved" | "self_approval_not_allowed" | "needs_more_approvers"
  | "proof_already_used" | "request_id_reused" | "not_the_approver" | "invalid_outcome";

export interface ApprovalRecord {
  requestId: string;
  kind: string;
  subjectId: string;
  outcome: DecisionOutcome;
  revision: number;
  artifactDigest: string;
  risk: string;
  decidedAt: string;
  approvers: ReadonlyArray<{ provider: string; personId: string; method: string }>;
  reason?: string;
}

export type GateResult =
  | { status: "decided"; record: ApprovalRecord; approver: Principal; result: Record<string, unknown> }
  /** The same decision was made earlier; nothing changed now. */
  | { status: "replayed"; record: ApprovalRecord }
  | { status: "refused"; reason: GateRefusalReason; /** The Approvers seam's own reason, or a fixed sentence. Never a token. */ detail: string };

export interface DecisionGatePolicy {
  /** The only methods that may approve a high-risk request. Default: the local session. */
  highRiskMethods?: readonly string[];
  /** The only methods that may reject or ask for changes. Default: the local session. */
  rejectMethods?: readonly string[];
  /** How long the used-proof markers are kept. Default: 400 days. */
  proofKeepSeconds?: number;
}

export interface DecisionGateDependencies {
  store: DocumentStore;
  approvers: Approvers;
  audit: AuditSink;
  subjects: readonly DecisionSubject[];
  policy?: DecisionGatePolicy;
  now?: () => Date;
}

export const LOCAL_SESSION_METHOD_NAME = "local-session";
const PROOF_KEEP_SECONDS = 400 * 86_400;
const REASON_MAX = 500;
const CREDENTIALS_MAX = 5;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

const refuse = (reason: GateRefusalReason, detail: string): GateResult => ({ status: "refused", reason, detail });

/** Where a decision's record lives: one per request id and company. */
export function approvalRecordKey(companyId: string, requestId: string): DocumentKey {
  return { pk: companyScoped(companyId, `APPROVAL#${requestId}`), sk: "DECISION" };
}

/** Where a used proof's marker lives: one per (method, token, request). The token itself is never stored, only its hash. */
export function approvalProofMarkerKey(companyId: string, proofKey: string): DocumentKey {
  return { pk: companyScoped(companyId, "APPROVAL_PROOF"), sk: proofKey };
}

function recordOf(document: StoredDocument): ApprovalRecord | undefined {
  const text = (name: string) => (typeof document[name] === "string" ? document[name] : undefined);
  const requestId = text("requestId"), kind = text("kind"), subjectId = text("subjectId"), outcome = text("outcome"), artifactDigest = text("artifactDigest"), risk = text("risk"), decidedAt = text("decidedAt");
  const revision = document["revision"];
  const approvers = document["approvers"];
  if (requestId === undefined || kind === undefined || subjectId === undefined || artifactDigest === undefined || risk === undefined || decidedAt === undefined || typeof revision !== "number" || !Array.isArray(approvers)) return undefined;
  if (outcome !== "approve" && outcome !== "reject" && outcome !== "request_changes") return undefined;
  const reason = text("reason");
  return {
    requestId, kind, subjectId, outcome, revision, artifactDigest, risk, decidedAt,
    approvers: approvers.flatMap((entry) => (typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof entry["provider"] === "string" && typeof entry["personId"] === "string" && typeof entry["method"] === "string"
      ? [{ provider: entry["provider"], personId: entry["personId"], method: entry["method"] }] : [])),
    ...(reason === undefined ? {} : { reason }),
  };
}


function recordDocument(companyId: string, record: ApprovalRecord, expires: number): StoredDocument {
  return {
    ...approvalRecordKey(companyId, record.requestId), entityType: "APPROVAL_DECISION", companyId, requestId: record.requestId, kind: record.kind, subjectId: record.subjectId, outcome: record.outcome,
    revision: record.revision, artifactDigest: record.artifactDigest, risk: record.risk, decidedAt: record.decidedAt,
    approvers: record.approvers.map((entry) => ({ provider: entry.provider, personId: entry.personId, method: entry.method })),
    ...(record.reason === undefined ? {} : { reason: record.reason }), [INDEX_EXPIRY_ATTRIBUTE]: expires,
  };
}

export interface DecisionGate {
  decide(attempt: DecisionAttempt): Promise<GateResult>;
  /** What the person can present for this subject now, so a surface offers the right way to answer (never decides anything). */
  requirement(companyId: string, kind: string, subjectId: string): Promise<{ requirement: ApprovalRequirement; risk: string; revision: number; artifactDigest: string } | undefined>;
}

export function createDecisionGate(deps: DecisionGateDependencies): DecisionGate {
  const now = deps.now ?? (() => new Date());
  const subjects = new Map(deps.subjects.map((subject) => [subject.kind, subject]));
  const highRiskMethods = deps.policy?.highRiskMethods ?? [LOCAL_SESSION_METHOD_NAME];
  const rejectMethods = deps.policy?.rejectMethods ?? [LOCAL_SESSION_METHOD_NAME];
  const proofKeepSeconds = deps.policy?.proofKeepSeconds ?? PROOF_KEEP_SECONDS;

  const sameDecision = (record: ApprovalRecord, attempt: DecisionAttempt): boolean =>
    record.kind === attempt.kind && record.subjectId === attempt.subjectId && record.outcome === attempt.outcome && record.revision === attempt.seen.revision && record.artifactDigest === attempt.seen.artifactDigest;

  /**
   * A repeat of a finished decision is answered again, and only to someone who holds the proof that made it: the used-proof marker of one of the presented credentials must be there for this request. A person who
   * only knows the request id (or presents another credential) is refused, never told "decided" by someone else's approval.
   */
  async function replayOf(attempt: DecisionAttempt): Promise<GateResult | undefined> {
    const earlier = await deps.store.get(approvalRecordKey(attempt.companyId, attempt.requestId));
    if (earlier === undefined) return undefined;
    const record = recordOf(earlier);
    // A row that cannot be read is not a decision this gate made: it cannot be answered, and the id stays used.
    if (record === undefined || !sameDecision(record, attempt)) return refuse("request_id_reused", "That request ID was already used for a different decision.");
    for (const credential of attempt.credentials) {
      const marker = await deps.store.get(approvalProofMarkerKey(attempt.companyId, approvalProofKey({ method: credential.method, token: credential.token, requestId: attempt.requestId })));
      if (marker !== undefined && marker["requestId"] === attempt.requestId) return { status: "replayed", record };
    }
    return refuse("request_id_reused", "That request ID was already used for a different decision.");
  }

  return {
    async requirement(companyId, kind, subjectId) {
      const subject = subjects.get(kind);
      const loaded = subject === undefined ? undefined : await subject.load(companyId, subjectId);
      if (loaded === undefined || !loaded.waiting) return undefined;
      const request: ApprovalRequest = { ...loaded.request, companyId, requestId: "requirement-probe" };
      return { requirement: await deps.approvers.requirement(request), risk: loaded.request.risk ?? "high", revision: loaded.request.revision, artifactDigest: loaded.request.artifactDigest };
    },

    async decide(attempt) {
      // ---- the shape of the attempt: nothing is read before this holds
      if (!REQUEST_ID.test(attempt.requestId)) return refuse("invalid", "The request ID is not valid.");
      if (attempt.outcome !== "approve" && attempt.outcome !== "reject" && attempt.outcome !== "request_changes") return refuse("invalid", "The outcome is not one this gate knows.");
      if (!Number.isSafeInteger(attempt.seen.revision) || attempt.seen.revision < 1 || !DIGEST.test(attempt.seen.artifactDigest)) return refuse("invalid", "What the person saw is not valid.");
      if (attempt.credentials.length < 1 || attempt.credentials.length > CREDENTIALS_MAX || attempt.credentials.some((credential) => credential.method === "" || credential.token === "")) return refuse("invalid", "A decision needs a proof.");
      const subject = subjects.get(attempt.kind);
      if (subject === undefined) return refuse("unsupported", "Rovara does not decide this kind of request here.");

      // ---- a repeat of a finished decision is answered again; it needs and changes nothing
      const replay = await replayOf(attempt);
      if (replay !== undefined) return replay;

      // ---- the current state of the subject, not the caller's account of it
      const loaded = await subject.load(attempt.companyId, attempt.subjectId);
      if (loaded === undefined) return refuse("not_found", "There is nothing here to decide.");
      if (!loaded.waiting) return refuse("not_waiting", "This is no longer waiting for a decision.");
      if (loaded.request.revision !== attempt.seen.revision || loaded.request.artifactDigest !== attempt.seen.artifactDigest) return refuse("stale", "This changed since you looked at it. Open it again to see the current version.");
      const at = now();
      if (loaded.request.expiresAt !== undefined && at.getTime() >= Date.parse(loaded.request.expiresAt)) return refuse("expired", "This request has expired.");

      // ---- who may answer, and how
      const request: ApprovalRequest = { ...loaded.request, companyId: attempt.companyId, requestId: attempt.requestId };
      const requirement = await deps.approvers.requirement(request);
      const risk = loaded.request.risk ?? "high";
      const policyMethods = attempt.outcome !== "approve" ? rejectMethods : risk === "high" ? highRiskMethods : undefined;
      const allowed = requirement.methods.filter((method) => policyMethods === undefined || policyMethods.includes(method));
      const presented = new Set<string>();
      for (const credential of attempt.credentials) {
        if (!allowed.includes(credential.method)) return refuse("method_not_allowed", "That way of approving is not available for this request.");
        // The same proof twice is one proof, not two approvers.
        const identity = `${credential.method}\u0000${credential.token}`;
        if (presented.has(identity)) return refuse("invalid", "The same proof was given twice.");
        presented.add(identity);
      }
      const proofs: ApprovalProof[] = attempt.credentials.map((credential) => ({
        proofId: randomUUID(), method: credential.method, requestId: attempt.requestId, revision: attempt.seen.revision, artifactDigest: attempt.seen.artifactDigest, token: credential.token,
        ...(credential.claimedAccount === undefined ? {} : { claimedAccount: credential.claimedAccount }),
      }));
      const approvers: Principal[] = [];
      for (const proof of proofs) {
        const verdict = await deps.approvers.verify(request, proof);
        if (!verdict.approved) {
          // The adapter remembers proofs it accepted. A repeat of a decision that has just committed is answered, not refused.
          if (verdict.reason === "proof_already_used") return (await replayOf(attempt)) ?? refuse("proof_already_used", "That proof was already used.");
          return refuse(verdict.reason === "expired" ? "expired" : "not_approved", `Not approved: ${verdict.reason}.`);
        }
        // Defence in depth: whatever the adapter vouched for must belong to this company.
        if (verdict.approver.companyId !== attempt.companyId) return refuse("not_approved", "Not approved: wrong_company.");
        approvers.push(verdict.approver);
      }
      const distinct = new Set(approvers.map((approver) => `${approver.provider}\u0000${approver.personId}`));
      if (distinct.size < Math.max(1, requirement.minApprovers)) return refuse("needs_more_approvers", `This needs ${String(requirement.minApprovers)} different approvers.`);
      const requester = request.requestedBy;
      if (!requirement.selfApprovalAllowed && requester !== undefined && approvers.some((approver) => approver.provider === requester.provider && approver.personId === requester.personId)) {
        return refuse("self_approval_not_allowed", "The person who asked cannot approve their own request.");
      }
      const approver = approvers[0]!;

      // ---- what the decision changes
      const decidedAt = at.toISOString();
      let applied: AppliedDecision;
      try {
        applied = await subject.apply(loaded, attempt, approver, decidedAt);
      } catch (error) {
        if (error instanceof SubjectRefusal) return refuse(error.code, error.message);
        throw error;
      }

      // ---- one transaction: the change under the subject's guard, the decision, the used proofs, the audit
      const reason = attempt.reason === undefined ? undefined : [...attempt.reason].slice(0, REASON_MAX).join("");
      const record: ApprovalRecord = {
        requestId: attempt.requestId, kind: attempt.kind, subjectId: attempt.subjectId, outcome: attempt.outcome, revision: attempt.seen.revision, artifactDigest: attempt.seen.artifactDigest, risk, decidedAt,
        approvers: approvers.map((entry, index) => ({ provider: entry.provider, personId: entry.personId, method: proofs[index]!.method })),
        ...(reason === undefined ? {} : { reason }),
      };
      const expires = Math.floor(at.getTime() / 1000) + proofKeepSeconds;
      const items: TransactItem[] = [
        { kind: "update", key: loaded.key, ops: applied.ops, condition: loaded.guard },
        { kind: "put", item: recordDocument(attempt.companyId, record, expires), condition: when.absent() },
        ...proofs.map((proof): TransactItem => ({
          kind: "put",
          item: { ...approvalProofMarkerKey(attempt.companyId, approvalProofKey(proof)), entityType: "APPROVAL_PROOF_USED", requestId: attempt.requestId, method: proof.method, usedAt: decidedAt, [INDEX_EXPIRY_ATTRIBUTE]: expires },
          condition: when.absent(),
        })),
        ...(applied.extra ?? []),
        ...deps.audit.stage({
          eventId: `approval:${attempt.requestId}`, companyId: attempt.companyId, at: decidedAt,
          actor: { type: "person", id: approver.personId }, action: `decision.${attempt.outcome === "approve" ? "approved" : attempt.outcome === "reject" ? "rejected" : "changes_requested"}`,
          subject: request.subject, details: { kind: attempt.kind, risk, revision: attempt.seen.revision, method: proofs[0]!.method },
        }),
      ];
      const committed = await deps.store.transact(items);
      if (committed.applied) return { status: "decided", record, approver, result: applied.result ?? {} };

      // ---- a lost race: say which rule lost
      const proofStart = 2;
      const proofEnd = proofStart + proofs.length;
      if (committed.failed.some((index) => index >= proofStart && index < proofEnd)) return refuse("proof_already_used", "That proof was already used.");
      if (committed.failed.includes(1)) {
        const again = await replayOf(attempt);
        return again ?? refuse("request_id_reused", "That request ID was already used for a different decision.");
      }
      const current = await subject.load(attempt.companyId, attempt.subjectId);
      return current === undefined || !current.waiting ? refuse("not_waiting", "This is no longer waiting for a decision.") : refuse("stale", "This changed while you decided. Open it again to see the current version.");
    },
  };
}
