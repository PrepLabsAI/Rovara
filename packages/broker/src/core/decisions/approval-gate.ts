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
//   - policy on top of the seam, which only narrows what it allows: a high-risk approval and every rejection accept only the methods the approvers plug-in names as strong (`ApprovalRequirement.strongMethods`,
//     `rejectMethods`; default the local session) and NEVER a comment method (`strong-methods.ts`: `code-host-comment`, any `code-host-*`, the plug-in's `commentMethods`), whatever is named (a comment is an approval of a change
//     request, and says nothing about a rejection); a request for changes accepts the methods the plug-in names (default the local session or a comment); the gate's policy option can only narrow the plug-in's sets (or the default when it names none; `createDecisionGate` refuses a policy of only comment methods for a strong set, and `verifyPolicy` refuses one that
//     is disjoint from the plug-in's sets, instead of a silent lock-out); when the plug-in sets a sign-in rule (`ApprovalRequirement.signIn`, a company setting) the approver's sign-in time must satisfy it for a
//     high-risk approval and a rejection; a request that does not allow self-approval refuses the person who asked; `minApprovers` distinct approvers are needed.
//   - nothing a caller can send widens it: an unknown kind, subject or method is a refusal, not a default.
// It never throws for a refusal (a refusal is an answer); it throws only for a fault of the store.
import { createHash, randomUUID } from "node:crypto";
import { isCommentMethod, strictMethodsFor } from "./strong-methods.js";

export { isCommentMethod, strictMethodsFor } from "./strong-methods.js";
import {
  INDEX_EXPIRY_ATTRIBUTE, approvalProofKey, checkApprovalSignIn, companyScoped, when,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type Approvers, type AuditSink, type Condition, type DocumentKey, type DocumentStore, type ExternalAccountRef, type IdentityProvider, type Principal,
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
  /** Works out what the decision changes. Gets EVERY verified approver (the first is the one the decision is recorded under); the subject's own rule must hold for each. Throws `SubjectRefusal`. Pure apart from reading `loaded`. */
  apply(loaded: LoadedSubject, attempt: DecisionAttempt, approvers: readonly Principal[], at: string): AppliedDecision | Promise<AppliedDecision>;
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
  | "proof_already_used" | "request_id_reused" | "not_the_approver" | "invalid_outcome" | "sign_in_not_fresh";

export interface ApprovalRecord {
  requestId: string;
  kind: string;
  subjectId: string;
  outcome: DecisionOutcome;
  revision: number;
  artifactDigest: string;
  risk: string;
  decidedAt: string;
  /** What the Approvers seam was asked about, kept so a repeat can be verified again. */
  subjectType: string;
  approvalKind: string;
  projectName?: string;
  /** `authTime` is the approver's sign-in time when the identity adapter knew it (lane P3, item A1). Code records it and does not use it. */
  approvers: ReadonlyArray<{ provider: string; personId: string; method: string; authTime?: string }>;
  reason?: string;
}

export type GateResult =
  | { status: "decided"; record: ApprovalRecord; approver: Principal; result: Record<string, unknown> }
  /** The same decision was made earlier; nothing changed now. */
  | { status: "replayed"; record: ApprovalRecord }
  | { status: "refused"; reason: GateRefusalReason; /** The Approvers seam's own reason, or a fixed sentence. Never a token. */ detail: string };

export interface DecisionGatePolicy {
  /** Limits the methods that may approve a high-risk request to these, among the ones the approvers plug-in names (`strongMethods`; when it names none, among the local session). Narrows only. A comment method is never accepted. */
  highRiskMethods?: readonly string[];
  /** Limits the methods that may reject to these, among the plug-in's `rejectMethods`. Narrows only. A comment method is never accepted. */
  rejectMethods?: readonly string[];
  /** The only methods that may ask for changes. Overrides the plug-in's `changesMethods`. Default: what the plug-in names, else the local session or a repository writer's comment (owner decision 62, A3: asking for changes by comment is allowed; rejecting is not). */
  changesMethods?: readonly string[];
  /** How long the used-proof markers are kept. Default: 400 days. */
  proofKeepSeconds?: number;
  /**
   * The methods whose credential is a long-lived session, good for many decisions (the local session). Every other method (a code host comment) is good for ONE decision, anywhere: its (method, token) is
   * marked used with no request in it, so one comment cannot approve a second revision or subject. Default: the local session.
   */
  reusableMethods?: readonly string[];
}

export interface DecisionGateDependencies {
  store: DocumentStore;
  approvers: Approvers;
  audit: AuditSink;
  subjects: readonly DecisionSubject[];
  policy?: DecisionGatePolicy;
  /** The identity adapter, for its capabilities: a sign-in rule of `any-active` is honoured only when `capabilities.companySignIn` is true (lane P3, decision 62). Absent: it is not. */
  identity?: Pick<IdentityProvider, "capabilities">;
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
  return { pk: companyScoped(companyId, `APPROVAL_DECISION#${requestId}`), sk: "DECISION" };
}

/**
 * What a proof is bound to, worked out by the server from the stored state, never taken from the caller: the company, the kind of subject, the subject, and the exact revision and content digest. The caller's
 * request id only names the decision record (idempotency); it is NOT what a proof is used up under, so a proof cannot be re-spent under a fresh request id.
 */
export function approvalBindingId(companyId: string, kind: string, subjectId: string, revision: number, artifactDigest: string): string {
  return `bind_${createHash("sha256").update(JSON.stringify([companyId, kind, subjectId, revision, artifactDigest]), "utf8").digest("hex")}`;
}

/**
 * What the Approvers seam sees as the request id: the decision's request id (the one a page or a comment names and signs over), plus a fresh part, so an adapter's own memory of proofs it accepted can never
 * burn a retry after a fault (the gate's transactional markers are the single-use rule). The proof checks of a surface (the local pages sign a proof over the request id) use `decisionRequestIdOf`.
 */
const adapterRequestId = (requestId: string): string => `${requestId}.${randomUUID()}`;

/** The decision's request id inside the id the Approvers seam was given (a request id has no dot, so everything before the first one). */
export const decisionRequestIdOf = (adapterRequest: string): string => adapterRequest.split(".")[0]!;

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
    requestId, kind, subjectId, outcome, revision, artifactDigest, risk, decidedAt, subjectType: text("subjectType") ?? "task", approvalKind: text("approvalKind") ?? kind,
    ...(text("projectName") === undefined ? {} : { projectName: text("projectName")! }),
    approvers: approvers.flatMap((entry) => (typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof entry["provider"] === "string" && typeof entry["personId"] === "string" && typeof entry["method"] === "string"
      ? [{ provider: entry["provider"], personId: entry["personId"], method: entry["method"], ...(typeof entry["authTime"] === "string" ? { authTime: entry["authTime"] } : {}) }] : [])),
    ...(reason === undefined ? {} : { reason }),
  };
}


function recordDocument(companyId: string, record: ApprovalRecord, expires: number): StoredDocument {
  return {
    ...approvalRecordKey(companyId, record.requestId), entityType: "APPROVAL_DECISION", companyId, requestId: record.requestId, kind: record.kind, subjectId: record.subjectId, outcome: record.outcome,
    revision: record.revision, artifactDigest: record.artifactDigest, risk: record.risk, decidedAt: record.decidedAt, subjectType: record.subjectType, approvalKind: record.approvalKind,
    ...(record.projectName === undefined ? {} : { projectName: record.projectName }),
    approvers: record.approvers.map((entry) => ({ provider: entry.provider, personId: entry.personId, method: entry.method, ...(entry.authTime === undefined ? {} : { authTime: entry.authTime }) })),
    ...(record.reason === undefined ? {} : { reason: record.reason }), [INDEX_EXPIRY_ATTRIBUTE]: expires,
  };
}

const POLICY_SETS = [["highRiskMethods", "approve", "high"], ["rejectMethods", "reject", "low"], ["changesMethods", "request_changes", "low"]] as const;

export interface DecisionGate {
  decide(attempt: DecisionAttempt): Promise<GateResult>;
  /**
   * A startup check for a gate built with a `policy`: asks the approvers plug-in what it requires and throws a clear error when the policy would leave a set empty that the plug-in made non-empty (every high-risk approval, rejection or
   * request for changes would then be refused, silently). Call it once when the install starts. Does nothing when no policy limits a set.
   */
  verifyPolicy(companyId: string): Promise<void>;
  /** What the person can present for this subject now, so a surface offers the right way to answer (never decides anything). */
  requirement(companyId: string, kind: string, subjectId: string): Promise<{ requirement: ApprovalRequirement; risk: string; revision: number; artifactDigest: string } | undefined>;
}

export function createDecisionGate(deps: DecisionGateDependencies): DecisionGate {
  // A policy that can only ever lock the gate out is a mistake in the install's code: it stops here, not at the first decision. A strong set (high risk, reject) never takes a comment method, so a non-empty policy of only those is empty.
  for (const name of ["highRiskMethods", "rejectMethods"] as const) {
    const named = deps.policy?.[name];
    if (named !== undefined && named.length > 0 && named.every((method) => isCommentMethod(method))) {
      throw new Error(`The approval gate's policy ${name} names only comment methods (${named.join(", ")}), which this gate never accepts for that answer, so every such decision would be refused.`);
    }
  }
  const now = deps.now ?? (() => new Date());
  const subjects = new Map(deps.subjects.map((subject) => [subject.kind, subject]));
  const highRiskMethods = deps.policy?.highRiskMethods;
  const rejectMethods = deps.policy?.rejectMethods;
  const changesMethods = deps.policy?.changesMethods;
  const proofKeepSeconds = deps.policy?.proofKeepSeconds ?? PROOF_KEEP_SECONDS;
  const reusableMethods = deps.policy?.reusableMethods ?? [LOCAL_SESSION_METHOD_NAME];
  const markerOf = (companyId: string, method: string, token: string, bindingId: string): DocumentKey => approvalProofMarkerKey(companyId, approvalProofKey({ method, token, requestId: bindingId }));
  /** The marker of a one-decision credential (a comment) that names no request: it is spent once, anywhere. */
  const spentOnceKey = (companyId: string, method: string, token: string): DocumentKey => approvalProofMarkerKey(companyId, approvalProofKey({ method, token, requestId: "*" }));

  const sameDecision = (record: ApprovalRecord, attempt: DecisionAttempt): boolean =>
    record.kind === attempt.kind && record.subjectId === attempt.subjectId && record.outcome === attempt.outcome && record.revision === attempt.seen.revision && record.artifactDigest === attempt.seen.artifactDigest;

  /**
   * A repeat of a finished decision is answered again, and only to someone who still holds the proof that made it: a used-proof marker of one of the presented credentials must be there for this decision, and the
   * Approvers seam must vouch for that credential again (a revoked session or a deleted comment is refused), as the person who made the decision. A person who only knows the request id is refused.
   */
  async function replayOf(attempt: DecisionAttempt): Promise<GateResult | undefined> {
    const earlier = await deps.store.get(approvalRecordKey(attempt.companyId, attempt.requestId));
    if (earlier === undefined) return undefined;
    const record = recordOf(earlier);
    // A row that cannot be read is not a decision this gate made: it cannot be answered, and the id stays used.
    const reused = refuse("request_id_reused", "That request ID was already used for a different decision.");
    if (record === undefined || !sameDecision(record, attempt)) return reused;
    const bindingId = approvalBindingId(attempt.companyId, record.kind, record.subjectId, record.revision, record.artifactDigest);
    for (const credential of attempt.credentials) {
      const marker = await deps.store.get(markerOf(attempt.companyId, credential.method, credential.token, bindingId));
      if (marker === undefined || marker["requestId"] !== attempt.requestId) continue;
      const request: ApprovalRequest = {
        companyId: attempt.companyId, requestId: adapterRequestId(attempt.requestId), kind: record.approvalKind, outcome: attempt.outcome, subject: { type: record.subjectType, id: record.subjectId }, revision: record.revision, artifactDigest: record.artifactDigest,
        ...(record.projectName === undefined ? {} : { projectName: record.projectName }),
        // The risk the decision was made at: a method that is good only below high risk (a chat press) is asked about the same request again.
        ...(record.risk === "low" || record.risk === "medium" || record.risk === "high" ? { risk: record.risk } : {}),
      };
      const verdict = await deps.approvers.verify(request, {
        proofId: randomUUID(), method: credential.method, requestId: request.requestId, revision: record.revision, artifactDigest: record.artifactDigest, token: credential.token,
        ...(credential.claimedAccount === undefined ? {} : { claimedAccount: credential.claimedAccount }),
      });
      // A comment is spent once, so the adapter may remember it; the marker above is what proved this person made the decision.
      if (verdict.approved && verdict.approver.companyId === attempt.companyId && record.approvers.some((entry) => entry.provider === verdict.approver.provider && entry.personId === verdict.approver.personId)) return { status: "replayed", record };
    }
    return reused;
  }

  return {
    async verifyPolicy(companyId) {
      if (deps.policy === undefined) return;
      const requirement = await deps.approvers.requirement({
        companyId, requestId: "policy-probe", kind: "policy-probe", subject: { type: "policy", id: "probe" }, revision: 1, artifactDigest: "0".repeat(64), risk: "high",
      });
      const offered = (methods: readonly string[] | undefined): readonly string[] => (methods ?? []).filter((method) => requirement.methods.includes(method));
      const policy = { highRiskMethods, rejectMethods, changesMethods };
      const empty = POLICY_SETS.filter(([name, outcome, risk]) => policy[name] !== undefined && offered(strictMethodsFor(outcome, risk, requirement)).length > 0 && offered(strictMethodsFor(outcome, risk, requirement, policy)).length === 0).map(([name]) => name);
      if (empty.length > 0) throw new Error(`The approval gate's policy (${empty.join(", ")}) leaves no method the approvers plug-in accepts, so those decisions would always be refused.`);
    },

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
      // A time that cannot be read never lets a request live for ever.
      if (loaded.request.expiresAt !== undefined && !(at.getTime() < Date.parse(loaded.request.expiresAt))) return refuse("expired", "This request has expired.");

      // ---- who may answer, and how
      const bindingId = approvalBindingId(attempt.companyId, attempt.kind, attempt.subjectId, loaded.request.revision, loaded.request.artifactDigest);
      const request: ApprovalRequest = { ...loaded.request, companyId: attempt.companyId, requestId: adapterRequestId(attempt.requestId), outcome: attempt.outcome };
      const requirement = await deps.approvers.requirement(request);
      const risk = loaded.request.risk ?? "high";
      const policyMethods = strictMethodsFor(attempt.outcome, risk, requirement, { highRiskMethods, rejectMethods, changesMethods });
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
        proofId: randomUUID(), method: credential.method, requestId: request.requestId, revision: attempt.seen.revision, artifactDigest: attempt.seen.artifactDigest, token: credential.token,
        ...(credential.claimedAccount === undefined ? {} : { claimedAccount: credential.claimedAccount }),
      }));
      const approvers: Principal[] = [];
      for (const proof of proofs) {
        const verdict = await deps.approvers.verify(request, proof);
        if (!verdict.approved) {
          // An adapter that remembers proofs it accepted may still say so: a repeat of a decision that has just committed is answered, not refused.
          if (verdict.reason === "proof_already_used") return (await replayOf(attempt)) ?? refuse("proof_already_used", "That proof was already used.");
          return refuse(verdict.reason === "expired" ? "expired" : "not_approved", `Not approved: ${verdict.reason}.`);
        }
        // Defence in depth: whatever the adapter vouched for must belong to this company.
        if (verdict.approver.companyId !== attempt.companyId) return refuse("not_approved", "Not approved: wrong_company.");
        approvers.push(verdict.approver);
      }
      const distinct = new Set(approvers.map((approver) => `${approver.provider}\u0000${approver.personId}`));
      if (distinct.size < Math.max(1, requirement.minApprovers)) return refuse("needs_more_approvers", `This needs ${String(requirement.minApprovers)} different approvers.`);
      // The company's sign-in rule (decision 62), set by the approvers plug-in, for the answers that need a strong proof. Code sets none.
      if (requirement.signIn !== undefined && policyMethods !== undefined && attempt.outcome !== "request_changes") {
        for (const person of approvers) {
          const fresh = checkApprovalSignIn(requirement.signIn, person, at.getTime(), { companySignIn: deps.identity?.capabilities.companySignIn === true });
          if (!fresh.ok) return refuse("sign_in_not_fresh", fresh.reason === "no_sign_in_time" ? "Sign in again to do this: Rovara has no record of when you signed in." : fresh.reason === "sign_in_too_old" ? "Sign in again to do this: your sign-in is too old." : "Sign in again to do this: your sign-in cannot be checked.");
        }
      }
      const requester = request.requestedBy;
      if (!requirement.selfApprovalAllowed && requester !== undefined && approvers.some((approver) => approver.provider === requester.provider && approver.personId === requester.personId)) {
        return refuse("self_approval_not_allowed", "The person who asked cannot approve their own request.");
      }
      const approver = approvers[0]!;

      // ---- what the decision changes
      const decidedAt = at.toISOString();
      const reason = attempt.reason === undefined ? undefined : [...attempt.reason].slice(0, REASON_MAX).join("");
      let applied: AppliedDecision;
      try {
        applied = await subject.apply(loaded, reason === undefined ? attempt : { ...attempt, reason }, approvers, decidedAt);
      } catch (error) {
        if (error instanceof SubjectRefusal) return refuse(error.code, error.message);
        throw error;
      }

      // ---- one transaction: the change under the subject's guard, the decision, the used proofs, the audit
      const record: ApprovalRecord = {
        requestId: attempt.requestId, kind: attempt.kind, subjectId: attempt.subjectId, outcome: attempt.outcome, revision: attempt.seen.revision, artifactDigest: attempt.seen.artifactDigest, risk, decidedAt,
        subjectType: request.subject.type, approvalKind: request.kind, ...(request.projectName === undefined ? {} : { projectName: request.projectName }),
        approvers: approvers.map((entry, index) => ({ provider: entry.provider, personId: entry.personId, method: proofs[index]!.method, ...(entry.authTime === undefined ? {} : { authTime: entry.authTime }) })),
        ...(reason === undefined ? {} : { reason }),
      };
      const expires = Math.floor(at.getTime() / 1000) + proofKeepSeconds;
      const items: TransactItem[] = [
        { kind: "update", key: loaded.key, ops: applied.ops, condition: loaded.guard },
        { kind: "put", item: recordDocument(attempt.companyId, record, expires), condition: when.absent() },
        ...proofs.map((proof): TransactItem => ({
          kind: "put",
          item: { ...markerOf(attempt.companyId, proof.method, proof.token, bindingId), entityType: "APPROVAL_PROOF_USED", requestId: attempt.requestId, method: proof.method, usedAt: decidedAt, [INDEX_EXPIRY_ATTRIBUTE]: expires },
          condition: when.absent(),
        })),
        // A credential that is good for one decision (a comment) is also spent for every other request, so it cannot approve a later revision or another subject.
        ...proofs.filter((proof) => !reusableMethods.includes(proof.method)).map((proof): TransactItem => ({
          kind: "put",
          item: { ...spentOnceKey(attempt.companyId, proof.method, proof.token), entityType: "APPROVAL_PROOF_SPENT", requestId: attempt.requestId, method: proof.method, usedAt: decidedAt, [INDEX_EXPIRY_ATTRIBUTE]: expires },
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
      const onceCount = proofs.filter((proof) => !reusableMethods.includes(proof.method)).length;
      const proofEnd = proofStart + proofs.length + onceCount;
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
